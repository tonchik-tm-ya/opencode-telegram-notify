# opencode-telegram-notify

Telegram-уведомления и удалённое управление для [opencode](https://opencode.ai/).

Уйдёшь от компьютера — и всё под контролем в телефоне:

- ✅ **Завершение задачи** — с описанием задачи и длительностью
- ❌ **Ошибки** — текст ошибки
- 🟧 **Запросы разрешений** — с кнопками «Разово / Всегда / Отклонить»: ответь прямо из Telegram
- ❓ **Вопросы агента** — вопрос приходит с кнопкой под каждый вариант; нажмёшь — агент продолжит сам
- ✍️ **Свободный текстовый ответ** — ответь на вопрос текстом (Reply на сообщение или просто сообщением при одном висящем вопросе)
- 💬 **Команды бота** — `/help`, `/status`, `/mute`, `/unmute`, `/watch`, `/unwatch`, `/lang`
- 🎨 **Настраиваемый формат** — свои эмодзи и шаблоны сообщений через конфиг; встроенные языки `ru`/`en`

## Требования

- opencode v1 (проверено на 1.19.0)
- Telegram-аккаунт

## Установка

### Быстрый вариант (скрипт install.sh)

Установка одной командой с GitHub:

```bash
curl -sL https://raw.githubusercontent.com/tonchik-tm-ya/opencode-telegram-notify/master/install.sh | bash
```

Либо клонируй репозиторий и запусти:

```bash
git clone https://github.com/tonchik-tm-ya/opencode-telegram-notify.git
cd opencode-telegram-notify && bash install.sh
```

Скрипт копирует плагин в `~/.config/opencode/plugins/`, при наличии проверяет SHA-256 чексумму (`telegram-notify.ts.sha256` в репозитории) и создаёт конфиг из примера (существующий конфиг не перезаписывает).

### 1. Создай бота

1. Открой Telegram, найди **@BotFather**, отправь `/newbot`
2. Придумай имя и username, скопируй **токен** (вида `123456789:AAH...`)

### 2. Получи chat_id

1. Напиши своему боту любое сообщение (например «привет»)
2. Выполни:
   ```bash
   curl "https://api.telegram.org/bot<ТОКЕН>/getUpdates"
   ```
3. В ответе найди `"chat":{"id":<ЧИСЛО>}` — это твой `chatId`

### 3. Скопируй плагин

```bash
mkdir -p ~/.config/opencode/plugins
cp telegram-notify.ts ~/.config/opencode/plugins/
```

### 4. Добавь конфиг с кредами

```bash
cp telegram-notify.json.example ~/.config/opencode/telegram-notify.json
# отредактируй — впиши свой токен и chatId
```

Либо задай переменные окружения (приоритет выше конфиг-файла):

```bash
export OPENCODE_NOTIFY_TELEGRAM_BOT_TOKEN="123456789:AAH..."
export OPENCODE_NOTIFY_TELEGRAM_CHAT_ID="123456789"
```

### 5. Перезапусти opencode

Плагины грузятся при старте. Готово — первое уведомление придёт после завершения любого хода.

## Как это работает

Плагин слушает события сервера opencode:

| Событие | Что приходит в Telegram |
|---|---|
| `session.idle` | `✅ <проект> <заголовок сессии> [агент] (длительность последнего хода)` |
| `session.error` и др. | `❌ <описание> + текст ошибки` |
| `permission.asked` | `🟧 тип + целевая папка` (извлекается из команды) + кнопки **Разово / Всегда / Отклонить** |
| `question.asked` | `❓ вопрос` + кнопка под каждый вариант → ответ возвращается в opencode |

Заголовок сессии берётся из `session.title` (если осмысленный и не «New session»), иначе — первое user-сообщение.

Ответы отправляются через внутренний HTTP-клиент opencode: вопрос — `POST /question/<requestID>/reply` (кнопка «Отклонить» — `POST /question/<requestID>/reject`), разрешение — `POST /session/<sessionID>/permissions/<permissionID>`. Пути для вопроса собираются вручную — SDK-подстановка параметров в путь не работает.

**Несколько экземпляров opencode:** опрос Telegram ведёт один процесс (лок-файл с PID); нажатия кнопок и текстовые ответы обрабатываются только в своём экземпляре (проверки `chatId` и `ownerPid`), а отвечает на вопросы и разрешения тот экземпляр, где они возникли, — через общие файлы состояния в конфиг-директории.

**Безопасность:** кнопки обрабатываются только для `chatId` из конфига; чужие чаты игнорируются. Токен хранится локально в конфиг-файле (или env) и не попадает в код.

## Тонкая настройка

- **Мультивыбор вопросов** (`multiple: true`) — кнопки-переключатели: нажатие отмечает/снимает вариант; внизу «✔️ Готово» и «✕ Отклонить» в одной строке
- **Свободный ввод** — текст из Telegram принимается и без Reply (если висит ровно один вопрос), и через Reply на сообщение вопроса
- Пути к файлам состояния: поддиректория `~/.config/opencode/telegram-notify/` (создаётся автоматически)

### Конфигурация

Все настройки формата — в `~/.config/opencode/telegram-notify.json` (шаблон: `telegram-notify.json.example`). Отсутствующие секции = поведение по умолчанию:

- `language` — язык интерфейса: `"en"` (по умолчанию) или `"ru"`
- `emojis` — свои эмодзи (`project`, `done`, `error`, `permission`, `question`, `reply`, `agent`)
- `format` — шаблоны сообщений с плейсхолдерами `{project}` `{task}` `{agent}` `{duration}` `{cost}` `{kind}` `{target}` `{question_text}` `{answer}` `{decision}` `{error_text}` (значения экранируются от HTML)
- `notify` — включить/выключить типы уведомлений: `done`, `errors`, `permissions`, `questions`
- `projects` — фильтр по имени проекта: `include` (только эти) и `exclude` (кроме этих)
- `quietHours` — тихие часы `{ "from": 23, "to": 8 }` (диапазон через полночь); глушат только DONE и ошибки, вопросы и разрешения приходят всегда
- `digest` — сборка DONE/ошибок в одно сообщение: `{ "enabled": true, "intervalMinutes": 15 }`
- `options` — `showCost` (стоимость в DONE), `questionTimeoutMinutes` (авто-отклонение зависших вопросов)

Кастомный перевод: переопределения key → string положи в `~/.config/opencode/telegram-notify-lang.json` (шаблон: `telegram-notify-lang.json.example`). Они перекрывают активный язык.

## Команды бота

| Команда | Действие |
|---|---|
| `/help` | Список команд |
| `/status` | Состояние: включённые уведомления, проекты, digest, тихие часы, debug |
| `/mute <тип>` | Выключить тип уведомлений (`done` \| `errors` \| `permissions` \| `questions`) |
| `/unmute <тип>` | Включить тип уведомлений |
| `/watch <проект>` | Подписаться на проект (добавить в `projects.include`) |
| `/unwatch <проект>` | Отписаться от проекта |
| `/lang <ru\|en>` | Сменить язык интерфейса |

Команды регистрируются в меню Telegram автоматически при старте плагина (`setMyCommands`) — появятся по кнопке «/».

## Диагностика

- Лог opencode: `~/.local/share/opencode/log/opencode.log` (префикс `telegram-notify`)
- `401 Unauthorized` — неверный токен; `400 chat not found` — неверный chatId
- Включить подробный журнал событий: в `~/.config/opencode/telegram-notify.json` добавить `"debug": true` (журнал пишется в `telegram-debug.log` в поддиректории `~/.config/opencode/telegram-notify/`)

## Лицензия

MIT