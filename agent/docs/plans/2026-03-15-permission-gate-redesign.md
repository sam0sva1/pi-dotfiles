# План: переработка permission-gate в workspace-first ask-based gate

## Краткое описание

Реализуем новую модель `permission-gate` для Pi с такими правилами:

- доверенная зона по умолчанию = текущий `cwd`
- внутри доверенной зоны автоматически разрешены только структурированные read-only tools: `read`, `ls`, `find`, `grep`
- доступ за пределы доверенной зоны не запрещается, а всегда спрашивается
- изменения (`edit`, `write`, создание файлов) подтверждаются по **конкретному файлу**, а session-grants действуют только на этот файл
- `bash` получает узкий allowlist; всё остальное спрашивается, а grants не должны расползаться шире точной команды
- meta-tools (`mcp`, `subagent`, team tools и аналоги) и sensitive paths всегда спрашиваются без широких session-grants
- активные grants живут только в памяти текущей сессии, но решения аудируются в session JSONL через custom entries

## Выбранный подход

Оставляем extension entry в `agent/extensions/permission-gate.ts`, но усиливаем архитектуру до **подхода 3**: кроме testable policy-core, вводим отдельные runtime-модули для state coordination, grants и notices.

Архитектурные роли:
- `core.ts` — pure policy logic: path/bash/tool classification, grant keys, prompt model, audit formatter, workspace signature helpers
- `runtime-state.ts` — координация config source, workspace-derived snapshots и lifecycle reset policy
- `grant-store.ts` — active session grants с точной семантикой **exact** vs **subtree** coverage
- `notice-store.ts` — pending/delivered notices с dedupe **по факту доставки**, а также с replacement semantics для устаревших config-notices
- `permission-gate.ts` — тонкий adapter-layer между Pi runtime (`pi.on(...)`, `ctx.ui`, `appendEntry`) и runtime/core модулями

Дополнительное архитектурное требование: runtime-модули не должны напрямую зависеть от пользовательского `~/.pi/agent/permission-gate.jsonc` как от жёстко зашитого глобального состояния. Для тестируемости вводим маленькую абстракцию config source / file I/O (или эквивалентный набор injected dependencies: `configPath`, `homeDir`, `readFile`, `writeFile`, `exists`, `mkdir`). Это позволит тестировать runtime-state и notice delivery в temp-fixtures, не трогая реальный пользовательский конфиг.

Это решение выбрано, потому что найденные замечания оказались не локальными багами, а симптомами неразделённых ответственностей:
- stale `policyContext` при изменении `cwd`
- incorrect browse grants как exact-key cache вместо subtree capability
- swallowed notices из-за неправильной модели delivery
- перегруженный runtime entrypoint, который знает слишком много о state semantics

Подход 3 дороже точечных hotfix’ов, но качественно снижает риск повторного появления тех же проблем и делает extension действительно plugin-like внутри своей архитектуры.

---

# Фаза 0. Зафиксировать обновлённую runtime-модель

## 0.1. Зафиксировать четыре runtime-сущности
**Что изменить**
- В плане и затем в коде явно зафиксировать:
  1. `RawConfigState` — последний успешно прочитанный JSONC/config source
  2. `WorkspacePolicySnapshot` — effective policy, вычисленная из raw config для конкретного `cwd`; трактуется как immutable snapshot и заменяется целиком при refresh, без in-place мутаций
  3. `GrantStore` — active grants текущей сессии с exact/subtree semantics
  4. `NoticeStore` — pending/delivered notices с delivery-aware dedupe

**Почему**
- Это устраняет смешение обязанностей, из-за которого появились stale snapshot, swallowed notices и неправильная модель browse grants.

**Принципы**
- SRP: каждая сущность отвечает только за один аспект runtime state
- GRASP Information Expert: логика lives рядом с теми данными, которыми управляет

## 0.2. Зафиксировать правило workspace-derived policy snapshot
**Что изменить**
- Явно описать и затем реализовать:
  - effective policy snapshot пересчитывается при изменении `cwd`
  - snapshot immutable: при любом refresh создаётся новый объект и целиком заменяет предыдущий
  - grants нельзя blindly reuse-ить через изменившуюся trust boundary
  - сброс grants определяется не raw `cwd`, а **effective workspace signature**

**Почему**
- Это ключевой fix против stale `policyContext`.

## 0.3. Зафиксировать два класса grants: exact и subtree
**Что изменить**
- Явно определить:
  - **exact grants**:
    - `modify-file:<abs-file>`
    - `read-path:<abs-path>`
    - `bash:<normalized-command>`
  - **subtree grants**:
    - `browse-path:<canonical-dir-root>`
- Явно записать: browse grant разрешает доступ только к subtree канонического каталога.

**Почему**
- `browse` — это capability на поддерево, а не string-equality cache.

### Как проверить после фазы 0
- Можно без двусмысленности ответить:
  - где хранится raw config
  - где живёт effective policy snapshot
  - где решается grant coverage
  - где решается доставка notices
- В плане нет неявной связи между `cwd`, grants и config notices

---

# Фаза 1. Подготовить runtime-модули под подход 3

## 1. Создать модуль `runtime-state.ts`
**Что изменить**
- Создать `agent/extensions/permission-gate/runtime-state.ts`
- Вынести туда runtime coordinator:
  - загрузку raw config
  - хранение текущего `WorkspacePolicySnapshot` как immutable value-object
  - хранение текущего workspace signature
  - интеграцию с grant store и notice store
  - dependency-injected config source / file I/O для безопасных unit tests
  - helper’ы:
    - `loadRawConfig()`
    - `refreshWorkspaceSnapshot(cwd)`
    - `getSnapshotForCwd(cwd)`
    - `resetSessionState(reason, cwd)`
    - `clearGrantsIfBoundaryChanged(cwd)`
    - `recordConfigNotices(...)`

**Почему**
- Сейчас entrypoint сам координирует state transitions и policy refresh, что делает его хрупким.

**TDD**
- **RED:** написать тесты на:
  - пересчёт snapshot при смене `cwd`
  - отсутствие stale snapshot
  - сброс grants только при изменении effective workspace signature
  - загрузку config через injected temp config source без касания реального `~/.pi/agent/permission-gate.jsonc`
- **GREEN:** реализовать coordinator минимально достаточным образом
- **REFACTOR:** убрать из `permission-gate.ts` прямое управление snapshot/grants/notices

## 2. Создать модуль `grant-store.ts`
**Что изменить**
- Создать `agent/extensions/permission-gate/grant-store.ts`
- Вынести туда:
  - типы grant records с явными полями `kind`, `scope`, `target`, `key`, `toolName`, `category`, `reason`, `createdAt`
  - `rememberGrant(decision)`
  - `hasCoverage(decision)`
  - `clear()`
  - `list()`
  - `size()`
- Разделить lookup rules:
  - `modify-file`, `read-path`, `bash` — **exact coverage**
  - `browse-path` — **ancestor/subtree coverage**

**Почему**
- Нынешний `Map.has(grantKey)` неверен для browse capabilities.
- Структурированные grant records позволяют `/permissions`, audit-adjacent formatting и runtime logic опираться на явную модель данных, а не на парсинг строкового ключа.

**TDD**
- **RED:** тесты на:
  - reuse exact grant только для exact target
  - reuse browse grant для nested subtree
  - отсутствие reuse между sibling directories
  - отсутствие reuse между browse grant и file grant
  - `list()` возвращает структурированные grant records без необходимости разбирать `key`
- **GREEN:** реализовать store
- **REFACTOR:** спрятать internal lookup details за store API

## 3. Создать модуль `notice-store.ts`
**Что изменить**
- Создать `agent/extensions/permission-gate/notice-store.ts`
- Вынести туда:
  - pending notices
  - delivered signatures
  - stable notice keys / origin tags (например, `config-parse-error`, `legacy-migration:tools.read`)
  - replacement semantics для notices одного происхождения
  - `enqueue(notices)`
  - `replacePending(origin, notices)` или эквивалентную операцию
  - `drainPending()` / `getPending()`
  - `markDelivered(notices)`
  - `hasPending()`
- Зафиксировать правило:
  - notice считается shown только после реальной доставки пользователю
  - без UI notice остаётся pending
  - новый reload config-notices заменяет недоставленные устаревшие config-notices того же происхождения, чтобы позже не показывать уже неактуальные parse/migration сообщения

**Почему**
- Текущая сигнатурная дедупликация основана не на delivery, а на вычислении, что семантически неверно.

**TDD**
- **RED:** тесты на:
  - pending notice не должен считаться delivered
  - repeated load без delivery не должен терять notice
  - после delivery notice не должен спамиться повторно
  - исправленный config reload не должен позже показывать устаревший parse/migration notice
- **GREEN:** реализовать store
- **REFACTOR:** удалить `lastNoticeSignature` из entrypoint

### Как проверить после фазы 1
- `permission-gate.ts` перестал сам хранить сложную семантику state
- Есть отдельные тесты на runtime-state, grant-store, notice-store
- Runtime modules координируют, но не дублируют policy logic из core

**Что может пойти не так**
- `runtime-state.ts` может превратиться в новый мини-монолит
- Можно случайно скопировать policy-решения из core вместо переиспользования core API

---

# Фаза 2. Доработать policy-core под новые runtime semantics

## 4. Явно разделить file-target и browse-target classification
**Что изменить**
- В `agent/extensions/permission-gate/core.ts`:
  - выделить или уточнить:
    - `classifyFileTarget(...)`
    - `classifyBrowseTarget(...)`
  - browse target всегда приводить к **canonical directory root**
  - file target сохранять на file-level
- `classifyPathAccess(...)` может остаться фасадом, но должен использовать эти специализированные classifier’ы

**Почему**
- Именно здесь должна жить разница между file capability и subtree capability.

**TDD**
- **RED:** тесты на:
  - `find ../proj-a` → browse grant root = каталог
  - `ls ../proj-a/src` → покрывается grant на `../proj-a`
  - file target outside root не получает browse-style normalization
- **GREEN:** обновить classifiers
- **REFACTOR:** убрать размытое равенство `browse-path === targetPath`

## 5. Добавить helper для workspace signature
**Что изменить**
- В `core.ts` или небольшом helper-модуле рядом добавить:
  - `buildWorkspaceSignature(snapshot)`
- В signature включить только данные, влияющие на trust boundary:
  - resolved trusted roots
  - resolved relative/absolute sensitive roots
  - при необходимости schema/version marker для future-safe evolution

**Почему**
- Нужно формально определить, когда grants становятся невалидны при смене workspace context.

**TDD**
- **RED:** тесты на:
  - один и тот же effective workspace → одинаковая signature
  - различная root geometry → разная signature
- **GREEN:** реализовать helper
- **REFACTOR:** сделать signature стабильной и детерминированной

## 6. Уточнить prompt model для exact vs subtree grants
**Что изменить**
- Обновить `buildPromptModel(...)`:
  - для browse-grant явно писать, что session grant распространяется на subtree каталога
  - для exact grants явно писать, что запоминается только этот файл/путь/команда
- Подготовить данные, пригодные для `/permissions`

**Почему**
- Пользователь должен понимать scope разрешения до подтверждения.

**TDD**
- **RED:** тесты на prompt messages для browse vs exact grant scenarios
- **GREEN:** обновить prompt builder
- **REFACTOR:** не смешивать prompt wording с runtime transitions

### Как проверить после фазы 2
- Core чётко отличает file-level и subtree-level capabilities
- Workspace signature воспроизводима и детерминированна
- Prompt точно описывает, что именно будет кэшироваться

**Что может пойти не так**
- Если browse normalization сделана неверно, subtree coverage снова станет непредсказуемой
- Слишком широкий workspace signature приведёт к лишним resets

---

# Фаза 3. Переписать `permission-gate.ts` как настоящий thin adapter

## 7. Подключить runtime coordinator в entrypoint
**Что изменить**
- В `agent/extensions/permission-gate.ts`:
  - убрать прямое хранение `policyContext`
  - убрать `lastNoticeSignature`
  - убрать raw `Map` grants semantics
  - подключить runtime-state, grant-store и notice-store
- Entry point должен отвечать только за:
  - lifecycle wiring
  - tool-call wiring
  - prompt execution
  - audit append
  - `/permissions` command wiring

**Почему**
- Это центральное требование подхода 3: entrypoint — adapter, а не policy/state hub.

**TDD**
- **RED:** regression tests/smoke checks на прежнее публичное поведение
- **GREEN:** переподключить entrypoint на новые модули
- **REFACTOR:** сократить file-level responsibilities

## 8. Перевести tool-call flow на coverage-aware grant checking
**Что изменить**
- Новый flow в `tool_call`:
  1. запросить актуальный snapshot для `ctx.cwd`
  2. при необходимости очистить grants при boundary change
  3. классифицировать доступ через core
  4. проверить coverage через `grantStore.hasCoverage(decision)`
  5. если coverage нет — показать prompt
  6. если выбран session grant — записать его через `grantStore.rememberGrant(...)`
- Убрать прямую проверку `Map.has(decision.grantKey)`

**Почему**
- Это исправляет both stale snapshot issue и browse subtree issue.

**TDD**
- **RED:** tests/helpers на decision → grant coverage flow
- **GREEN:** внедрить flow
- **REFACTOR:** убрать raw key-lookup из runtime

## 9. Внедрить delivery-aware notices в lifecycle hooks
**Что изменить**
- На lifecycle events:
  - `session_start`
  - `session_switch`
  - `session_fork`
  - `session_tree`
- Делать:
  - config reload
  - enqueue notices в notice-store
  - если есть UI — доставить pending notices и отметить их delivered
  - если UI нет — ничего не терять, notices остаются pending
- На tool calls, command handlers или следующих delivery-capable UI contexts доставлять pending notices, если они есть
- Здесь важно не предполагать буквальный переход процесса из no-UI mode в interactive mode; целевой кейс — notices, вычисленные до первого подходящего UI-capable контекста (например, на initial load до session event или при reload sequencing)

**Почему**
- Notices должны быть прозрачными, но не теряться и не спамиться.

**TDD**
- **RED:** сценарии:
  - notice вычислен до первого delivery-capable UI context
  - затем происходит первый подходящий UI event/command/tool flow
  - notice должен прийти один раз
- **GREEN:** внедрить notice flow
- **REFACTOR:** централизовать delivery logic

## 10. Уточнить reset policy для grants при изменении workspace signature
**Что изменить**
- В `runtime-state.ts` реализовать:
  - на `session_start/switch/fork/tree` → полный reset grants + reload config
  - на обычном tool call:
    - если `cwd` изменился, но effective workspace signature та же → grants сохраняются
    - если signature изменилась → grants очищаются перед принятием решения
- Не писать persistent audit на такой auto-clear, если это не user action; при необходимости использовать только UI notice/debug-level diagnostic behavior

**Почему**
- Это лучший баланс безопасности и UX, совместимый с workspace-first моделью.

**TDD**
- **RED:** тесты на:
  - новый `cwd`, та же signature → grants сохраняются
  - новый `cwd`, новая signature → grants очищаются
- **GREEN:** реализовать policy
- **REFACTOR:** сделать reset policy одной централизованной точкой

### Как проверить после фазы 3
- Entry point больше не знает, как устроен subtree coverage или notice delivery
- Snapshot всегда актуален относительно текущего workspace
- Grants не протекают через изменившуюся trust boundary
- Notices не теряются до реального показа

**Что может пойти не так**
- Неправильное вычисление signature приведёт либо к лишнему UX-noise, либо к security leakage

---

# Фаза 4. Улучшить `/permissions` поверх новой модели stores

## 11. Перевести `/permissions` на `grant-store`
**Что изменить**
- Команда `/permissions` должна использовать `grantStore.list()`
- Форматирование `/permissions` должно опираться на явные поля grant record (`kind`, `scope`, `target`), а не на парсинг `key`
- Отображать разные типы grants явно:
  - `modify-file`
  - `read-path`
  - `browse-path (subtree)`
  - `bash`
- `clear/reset` должны вызывать store-level `clear()` и писать audit entry `grant-clear`

**Почему**
- Так пользователь видит реальную capability model, а не внутреннюю `Map`.

**TDD**
- **RED:** тесты на mixed grant formatting
- **GREEN:** перевести команду на store output
- **REFACTOR:** убрать прямую сборку summary из runtime internals

## 12. Исправить UX-модель `/permissions`
**Что изменить**
- Не использовать `ctx.ui.select(...)` как псевдо-viewer списка строк
- Для этой итерации принять маленький, но честный interactive UI:
  - в interactive/RPC mode использовать компактный `ctx.ui.custom(...)` read-only viewer или эквивалентный минимальный custom component
  - в non-interactive / no-UI mode оставлять plain-text summary через stdout
  - `clear` / `reset` остаются явными action arguments команды
- Viewer не должен притворяться action menu для каждой строки grant list

**Почему**
- У Extension API нет надёжного встроенного read-only multiline viewer, кроме custom UI; `console.log`/`notify`/`select` не дают качественного интерактивного UX.
- Пользователь просил качество, поэтому здесь оправдан небольшой custom UI, но без раздувания в отдельную сложную TUI-систему.

**TDD**
- **RED:** tests/helpers на formatting grant summary для empty/non-empty grants и manual smoke checklist для interactive viewer
- **GREEN:** перевести `/permissions` на minimal custom viewer + plain-text fallback
- **REFACTOR:** отделить formatting данных от UI rendering

### Как проверить после фазы 4
- `/permissions` не маскирует текст под action menu
- В interactive mode grant list открывается как read-only viewer, а не selector списка действий
- В no-UI mode вывод остаётся plain-text
- `clear/reset` действительно чистит grants и аудируется

**Что может пойти не так**
- Можно случайно раздуть custom UI больше, чем нужно; важно держать viewer минимальным и read-only

---

# Фаза 5. Перестроить test suite под подход 3

## 13. Разделить тесты по архитектурным уровням
**Что изменить**
- Сохранить `agent/extensions/permission-gate/core.test.ts`
- Добавить:
  - `agent/extensions/permission-gate/grant-store.test.ts`
  - `agent/extensions/permission-gate/notice-store.test.ts`
  - `agent/extensions/permission-gate/runtime-state.test.ts`
- При необходимости создать:
  - `agent/extensions/permission-gate/test-helpers.ts`

**Почему**
- Подход 3 добавляет runtime semantics, которые нельзя качественно покрыть только core tests.

**TDD**
- Эта фаза сама по себе RED-first: сначала фиксируем баги и boundary rules тестами, потом меняем код

## 14. Добавить regression tests на найденные замечания
**Что изменить**
- Отдельно зафиксировать тестами:
  - stale snapshot bug
  - browse subtree coverage bug
  - swallowed notices bug
  - `/permissions` output correctness

**Почему**
- Это конкретные причины текущего redesign’а, и они не должны вернуться.

### Как проверить после фазы 5
- Все ключевые замечания сначала воспроизводятся тестами на RED
- После реализации становятся зелёными
- Test suite отражает архитектуру runtime modules

**Что может пойти не так**
- Можно покрыть только helper-level cases и пропустить integration seams между runtime-state и entrypoint

---

# Фаза 6. Документация и финальная верификация

## 15. Обновить встроенную документацию и config comments
**Что изменить**
- Обновить header comment в `agent/extensions/permission-gate.ts`
- Обновить комментарии в `agent/permission-gate.jsonc`
- Явно отразить:
  - workspace-derived snapshots
  - exact vs subtree grants
  - browse subtree semantics
  - delivery-aware notices
  - reset grants при effective boundary change

**Почему**
- Иначе документация снова начнёт расходиться с реальным поведением.

**TDD**
- Не требуется; после кода провести consistency review

## 16. Прогнать финальную verification matrix
**Что изменить**
- Код больше не менять; выполнить итоговую проверку

**Проверки**
- Unit:
  - `core.test.ts`
  - `grant-store.test.ts`
  - `notice-store.test.ts`
  - `runtime-state.test.ts`
- Manual/integration:
  - read inside trusted root
  - read outside trusted root
  - read sensitive path
  - edit same file twice
  - edit second file in same directory
  - browse subtree reuse
  - sibling browse non-reuse
  - bash allowlist
  - bash risky ask-once
  - meta-tools ask-always
  - `cwd` change with same effective signature
  - `cwd` change with different effective signature
  - config reload on `session_start/switch/fork/tree`
  - notice buffering before first delivery-capable UI context, then later single delivery
  - config parse error fixed before delivery does not surface stale notice later
  - `/permissions`
  - session JSONL audit entries

**Почему**
- Подход 3 меняет не только pure policy, но и runtime semantics.

### Как проверить после фазы 6
- Все unit tests зелёные
- Smoke check `pi --help` не ломается из-за extension loading
- Manual matrix подтверждает, что замечания закрыты не только тестами, но и реальным поведением

**Что может пойти не так**
- Можно недопроверить переходные состояния вокруг `cwd`/snapshot/signature
- Можно забыть о no-UI сценариях для notices и prompts

---

# Риски и открытые вопросы

1. **Workspace signature может оказаться слишком широкой или слишком узкой**
   - Слишком широкая приведёт к лишним resets
   - Слишком узкая создаст риск reuse grants через сменившуюся trust boundary

2. **Browse subtree semantics должны остаться строгими**
   - Grant на каталог не должен превращаться в wildcard grant на весь outside-root доступ

3. **`runtime-state.ts` рискует снова стать монолитом**
   - Нужно удерживать его как coordinator, а не дублирующий policy engine

4. **UX `/permissions` не должен раздувать scope**
   - В этой итерации нужен минимальный read-only custom viewer, а не полноценная TUI-подсистема

5. **Notice delivery требует осторожной интеграции с реальным наличием UI**
   - Нельзя считать notice delivered без фактического показа
   - Нужно не показывать позже устаревшие pending notices, если subsequent config reload уже устранил проблему

6. **Runtime-state и notice-store должны быть тестируемы без доступа к реальному пользовательскому конфигу**
   - Для этого обязательна маленькая injected config source / file I/O abstraction

---

# Финальный checklist

- [ ] `permission-gate.ts` остаётся thin adapter, а не runtime/state monolith
- [ ] runtime state разделён на raw config / workspace snapshot / grants / notices
- [ ] `WorkspacePolicySnapshot` обновляется как immutable value-object, без in-place мутаций
- [ ] stale `cwd` bug устранён на уровне модели, а не точечным условием
- [ ] browse grants работают как subtree capabilities, а не как exact-key cache
- [ ] grants сбрасываются при изменении effective workspace signature
- [ ] notices dedupe-ятся по факту доставки, а не по факту вычисления
- [ ] устаревшие pending config-notices заменяются/очищаются и не показываются после исправления конфигурации
- [ ] `/permissions` отражает реальную capability model и не использует misleading action UI
- [ ] `/permissions` и formatting grants используют структурированные grant records, а не парсят строковый `key`
- [ ] path/file vs browse classification разделены в core
- [ ] regression tests на stale snapshot, browse coverage, swallowed notices и `/permissions` добавлены
- [ ] audit entries сохраняют только security-relevant decisions и grant-clear
- [ ] docs/comments/config согласованы с новым поведением
- [ ] manual/integration matrix пройдена
- [ ] после обновления плана выполнен `/plan-check` до начала реализации

---

# Оценка scope

## Файлы на изменение
- `agent/extensions/permission-gate.ts`
- `agent/extensions/permission-gate/core.ts`
- `agent/extensions/permission-gate/core.test.ts`
- `agent/permission-gate.jsonc`
- `agent/docs/plans/2026-03-15-permission-gate-redesign.md`

## Файлы на создание
- `agent/extensions/permission-gate/runtime-state.ts`
- `agent/extensions/permission-gate/grant-store.ts`
- `agent/extensions/permission-gate/notice-store.ts`
- `agent/extensions/permission-gate/runtime-state.test.ts`
- `agent/extensions/permission-gate/grant-store.test.ts`
- `agent/extensions/permission-gate/notice-store.test.ts`
- возможно `agent/extensions/permission-gate/test-helpers.ts`

## Файлы на удаление
- не ожидаются
