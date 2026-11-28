# Модуль «Сайт»: контракт API для фронтенда (лендинг everestlc)

Версия: 2026-11-28, ветка `feat/site-content`. Примеры ответов сняты с реального прогона на одноразовой базе (сид + несколько правок админа). `API_PUBLIC_URL` в примерах — `https://api.everestlc.tj`.

## Общее

- База: `/api/v1`. Успех: `{ "data": ... }`, ошибка: `{ "error": { "code", "message", "details": [{ "field", "message" }] } }`. Идентификаторы — десятичные строки.
- **Языки.** В публичных запросах `?lang=ru|tj|en` (по умолчанию `ru`; `tg` принимается как синоним `tj`; другое значение → `400 VALIDATION_ERROR`). Каждый переводимый текст берётся на запрошенном языке, а если там пусто — на русском (по каждому полю отдельно; пустой список тоже заменяется русским).
- **`lang` у каждого объекта** — язык, в котором объект показан: запрошенный, если у объекта есть свой заголовок на этом языке, иначе `ru`. У настроек: запрошенный, если на нём заполнено хоть одно поле. У списков есть ещё верхний `lang` — это запрошенный язык.
- **Кэш.** Все `GET /public/site/*` (кроме картинок) отдают `Cache-Control: public, max-age=60, stale-while-revalidate=300` (max-age задаётся `SITE_CACHE_MAX_AGE_SECONDS`) и слабый `ETag`; `If-None-Match` → `304`.
- **Публикация.** Публично видны только `published`. Неизвестный или черновой slug → `404 SITE_COURSE_NOT_FOUND`.
- **Изображение (публично):** `{ "url", "width", "height", "alt" }`. `url` абсолютный, на хосте API (`API_PUBLIC_URL`, если не задан — origin запроса): `GET /api/v1/public/site/images/{id}` отвечает `302` на подписанную ссылку хранилища. Ссылка внутри 10-минутного окна одинаковая (кэшируется браузером и next/image), живёт ~70 минут. Ширина и высота читаются из файла при загрузке. `alt` — на языке запроса; если alt не задан, берётся заголовок объекта.
- **Админка: переводимые поля** — один объект на поле `{ "ru", "tj", "en" }`. В ответах всегда все три ключа (`null` или `[]`, если пусто). В запросах можно прислать только нужные языки; `null` очищает язык. `title.ru` обязателен при создании и не может быть очищен. Внутри БД Tajik хранится как `tg` (строки переводов по языкам, как у предметов/разделов/тем).
- **Права.** Все `/admin/site/*` — разрешение `site.manage` (роли owner и admin). Без входа → `401 AUTHENTICATION_REQUIRED`, другие роли → `403 ACTION_FORBIDDEN`. Изменения с cookie-сессией требуют `X-CSRF-Token` (как во всей админке); Bearer — без CSRF.
- Заявок и форм нет: все CTA ведут в WhatsApp или на звонок.

## Таблицы

| Таблица | Что хранит |
|---|---|
| `site_courses` | slug (уник.), subject_key, format, cover_asset_id, course_id (курс платформы, NULL), status, position, published_at, created/updated |
| `site_course_translations` | по языку: title, summary, description, audience, duration, label, cover_alt, seo_title, seo_description, topics[], learn[], how_it_works[], program[{title, items[]}] |
| `site_vacancies` | slug (уник.), employment_type, salary_min/max/currency, date_posted, valid_through, status, position… |
| `site_vacancy_translations` | title, location, description, requirements[], conditions[] |
| `site_events` | event_type, mode, starts_at, ends_at, image_asset_id, status, position… |
| `site_event_translations` | title, description, location, image_alt |
| `site_videos` | provider, video_id, url, thumbnail_asset_id, duration, upload_date, placement, site_course_id, status, position… |
| `site_video_translations` | title, description, thumbnail_alt |
| `site_settings` | одна строка: phones[{number, label{ru,tg,en}}], whatsapp_phone, telegram/instagram username, play_market_url, geo_lat/lng, hours[], stats_enabled, stats[{value, label{ru,tg,en}}], hero_image_asset_id, seo_image_asset_id |
| `site_settings_translations` | address, whatsapp_template, whatsapp_course_template, hero_*, why_everest[], stages[], seo_title, seo_description, seo_image_alt |

Изображения — обычные строки `assets` (`source_metadata.scope = 'site'`). Права: новое разрешение `site.manage`. Вебхук идёт через `background_jobs` (тип `site.revalidate`).

## Публичные эндпоинты (без авторизации)

### GET /public/site/settings?lang=

```json
{
  "data": {
    "lang": "tj",
    "phones": [{ "number": "+992901234567", "label": "Қабулгоҳ" }],
    "whatsapp": "+992901234567",
    "whatsappTemplate": "Ассалому алейкум! Мехоҳам дар бораи курсҳои EVEREST маълумот гирам",
    "whatsappCourseTemplate": "Ассалому алейкум! Мехоҳам дар бораи курси «{course}»-и EVEREST маълумот гирам",
    "whatsappUrl": "https://wa.me/992901234567?text=%D0%90%D1%81%D1%81...",
    "telegram": "https://t.me/everest_lc",
    "instagram": "https://www.instagram.com/everest.lc",
    "playMarketUrl": null,
    "address": "Душанбе, кӯчаи Намунавӣ, 1",
    "geo": { "lat": 38.5598, "lng": 68.787 },
    "hours": [
      { "days": ["mon", "tue", "wed", "thu", "fri"], "opens": "08:00", "closes": "18:00" },
      { "days": ["sat"], "opens": "09:00", "closes": "14:00" }
    ],
    "stats": { "enabled": false, "items": [] },
    "hero": {
      "title": "Имрӯз барои имкониятҳои бузурги фардо омода мекунем",
      "subtitle": "Дониш, машқ ва дохилшавӣ: чор самт ва муҳити ягонаи рақамии таълим.",
      "primaryCta": "Ба курс сабти ном шудан",
      "secondaryCta": "Бештар маълумот",
      "image": { "url": "https://api.everestlc.tj/api/v1/public/site/images/1", "width": 1200, "height": 630, "alt": "Хонандагони EVEREST ҳангоми дарс" }
    },
    "whyEverest": [{ "title": "Омӯзгорони қавӣ", "text": "Мавзӯъҳои мураккабро фаҳмо мефаҳмонанд ва ритми таълимро нигоҳ медоранд." }],
    "stages": [{ "title": "Интихоби самт", "text": "Ҳадаф ва барномаи мувофиқро муайян мекунем." }],
    "seo": {
      "title": "EVEREST — омодагӣ ба ММТ ва дохилшавӣ",
      "description": "Маркази таълимии EVEREST: омодагии муназзам ба ММТ ...",
      "ogImage": { "url": "https://api.everestlc.tj/api/v1/public/site/images/1", "width": 1200, "height": 630, "alt": "EVEREST — омодагӣ ба ММТ ва дохилшавӣ" }
    },
    "updatedAt": "2026-11-28T10:10:24.440Z"
  }
}
```

- `whatsappUrl` — готовая ссылка с общим шаблоном. Для курса/вакансии/события подставьте `{course}` / `{vacancy}` / `{event}` в `whatsappCourseTemplate` (если `null` — в `whatsappTemplate`) и соберите `https://wa.me/<цифры номера>?text=<encodeURIComponent(текст)>`.
- `stats.items` пустой, пока `stats.enabled = false` (неподтверждённые цифры не уходят с сервера). Сейчас выключено.
- `whatsapp`, `telegram`, `instagram`, `playMarketUrl`, `address`, `geo`, `hero.image`, `seo.ogImage` могут быть `null`; `phones`, `hours` — `[]`. После сида контакты пустые.

### GET /public/site/courses?lang=

`{ "data": { "lang": "en", "courses": [ <курс>, ... ] } }` — опубликованные, в порядке админки (`order`). Объект курса — как в детальном ответе ниже.

### GET /public/site/courses/:slug?lang=

```json
{
  "data": {
    "id": "1",
    "lang": "tj",
    "slug": "biology",
    "subjectKey": "biology",
    "format": "hybrid",
    "title": "Биология",
    "summary": "Омодагии муназзам аз биология: аз ҳуҷайра то генетика ва саломатии инсон.",
    "description": "Курс тамоми биологияи мактабиро бо тартиб мегузарад: ...",
    "audience": "Хонандагон ва довталабон",
    "duration": "9 моҳ",
    "label": "Омодагӣ ба ММТ",
    "topics": ["Ситология", "Генетика", "Анатомия"],
    "learn": ["Сохт ва вазифаҳои ҳуҷайра", "Қонунҳои ирсият ва ҳалли масъалаҳои генетикӣ"],
    "howItWorks": ["Дарсҳо бо омӯзгор дар гурӯҳ", "Машқ ва таҳлили супоришҳо"],
    "program": [{ "title": "Ҳуҷайра", "items": ["Сохти ҳуҷайра", "Мубодилаи моддаҳо", "Тақсимшавии ҳуҷайра"] }],
    "seo": { "title": "Биология — подготовка к НЦТ", "description": null },
    "cover": { "url": "https://api.everestlc.tj/api/v1/public/site/images/1", "width": 1200, "height": 630, "alt": "Биология" },
    "platformCourseId": null,
    "order": 1,
    "updatedAt": "2026-11-28T10:10:24.140Z"
  }
}
```

- `subjectKey`: `biology | chemistry | physics | tajik` (иконка и цвет — как `subjectVisual` в приложении). `format`: `online | offline | hybrid`. `audience`, `duration`, `description`, `cover`, `seo.*` могут быть `null`.
- `label` («Подготовка к НЦТ») и `howItWorks` («Как проходит обучение») — из исходной задачи, в аудите их нет; можно не использовать.
- `seo` в примере пришёл на русском при `lang: "tj"` — это пофилдовый fallback.
- Ошибки: `404 SITE_COURSE_NOT_FOUND` (неизвестный, черновой или некорректный slug), `400 VALIDATION_ERROR` (lang).

### GET /public/site/vacancies?lang=

```json
{
  "data": {
    "lang": "ru",
    "vacancies": [{
      "id": "1", "lang": "ru", "slug": "biology-teacher", "employmentType": "FULL_TIME",
      "title": "Преподаватель биологии", "location": "Душанбе",
      "description": "Работа с мотивированными школьниками и подготовка к НЦТ.",
      "requirements": ["Профильное образование", "Умение объяснять сложное"],
      "conditions": ["Официальное оформление"],
      "salary": { "min": 4000, "max": 6000, "currency": "TJS" },
      "datePosted": "2026-11-28", "validThrough": "2027-01-31",
      "order": 1, "updatedAt": "2026-11-28T10:10:24.338Z"
    }]
  }
}
```

`employmentType`: `FULL_TIME | PART_TIME | CONTRACTOR | INTERN` (как в schema.org JobPosting). `salary` — `null` или `{ min?, max?, currency: "TJS" }` (одна из границ может быть `null`). `datePosted` проставляется при первой публикации, если не задан. Вакансии с прошедшим `validThrough` (по дате в Душанбе) в список не попадают. После сида все 3 вакансии — черновики, так что список пуст.

### GET /public/site/events?lang=

```json
{
  "data": {
    "lang": "ru",
    "events": [{
      "id": "2", "lang": "ru", "type": "mock-nct", "mode": "offline",
      "title": "Пробный НЦТ",
      "description": "Дата и условия диагностики знаний будут подтверждены центром.",
      "location": "Душанбе, учебный центр EVEREST",
      "startsAt": "2026-12-12T10:00:00+05:00", "endsAt": "2026-12-12T13:00:00+05:00",
      "timeZone": "Asia/Dushanbe",
      "image": { "url": "https://api.everestlc.tj/api/v1/public/site/images/1", "width": 1200, "height": 630, "alt": "Пробный НЦТ" },
      "order": 2, "updatedAt": "2026-11-28T10:10:24.383Z"
    }]
  }
}
```

`type`: `enrollment | mock-nct | open-lesson | other`; `mode`: `online | offline`. Время в ISO 8601 со смещением `+05:00`. У опубликованного события `startsAt` всегда есть; `endsAt`, `location`, `image` могут быть `null`. После сида все 3 события — черновики.

### GET /public/site/videos?lang=&placement=&courseSlug=

```json
{
  "data": {
    "lang": "ru",
    "videos": [{
      "id": "1", "lang": "ru", "provider": "youtube", "videoId": "dQw4w9WgXcQ",
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "embedUrl": "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "title": "Как проходит занятие", "description": "Фрагмент урока биологии",
      "thumbnail": { "url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "width": 480, "height": 360, "alt": "Как проходит занятие" },
      "duration": "PT3M33S", "uploadDate": "2026-11-28",
      "placement": "course", "courseSlug": "biology",
      "order": 1, "updatedAt": "2026-11-28T10:10:24.420Z"
    }]
  }
}
```

- `provider`: `youtube | vimeo | file`. `videoId` — у YouTube/Vimeo, у `file` — `null` (тогда `url` — прямой https-файл .mp4/.webm, `embedUrl: null`). Vimeo: `embedUrl` = `https://player.vimeo.com/video/{id}`.
- `thumbnail`: загруженная картинка, иначе для YouTube — `hqdefault` с YouTube (480×360), для Vimeo и файла — `null`.
- `duration` — ISO 8601 или `null`. `uploadDate` проставляется при первой публикации, если не задан.
- Фильтры: `placement=home|course`, `courseSlug=<slug>`.

### GET /public/site/images/:assetId

`302 Found`, `Location: <подписанная ссылка хранилища>`, `Cache-Control: public, max-age=600`. Неизвестный id или не-сайтовая картинка → `404 SITE_IMAGE_NOT_FOUND`; хранилище не настроено → `503 STORAGE_NOT_CONFIGURED`.

## Админские эндпоинты (site.manage: owner, admin)

`{entity}` = `courses | vacancies | events | videos`.

| Метод и путь | Что делает | Ответ |
|---|---|---|
| `GET /admin/site/settings` | настройки со всеми языками | `{ data: <settings> }` |
| `PUT /admin/site/settings` | сохранить настройки (сразу живые) | `{ data: <settings> }` |
| `POST /admin/site/images` | загрузить JPEG/PNG до 5 МБ | `201 { data: <image> }` |
| `GET /admin/site/{entity}?status=draft\|published` | все элементы, черновики тоже | `{ data: { items: [...] } }` |
| `POST /admin/site/{entity}` | создать (черновик, в конец) | `201 { data: <item> }` |
| `GET /admin/site/{entity}/:id` | один элемент | `{ data: <item> }` |
| `PATCH /admin/site/{entity}/:id` | изменить присланные поля | `{ data: <item> }` |
| `DELETE /admin/site/{entity}/:id` | удалить | `{ data: { id, status: "deleted" } }` |
| `PATCH /admin/site/{entity}/order` | новый порядок: `{ ids: [...] }` — все id ровно по разу | `{ data: { items: [...] } }` (order = 1..n) |
| `POST /admin/site/{entity}/:id/publish` | опубликовать (повтор — без изменений) | `{ data: <item> }` |
| `POST /admin/site/{entity}/:id/unpublish` | вернуть в черновик | `{ data: <item> }` |

Ошибки: `400 VALIDATION_ERROR` (с `details[0].field`, например `title.ru`, `phones[0].number`, `url`), `400 INVALID_SITE_ITEM_ID`, `404 SITE_COURSE_NOT_FOUND | SITE_VACANCY_NOT_FOUND | SITE_EVENT_NOT_FOUND | SITE_VIDEO_NOT_FOUND`, `409 SITE_COURSE_SLUG_CONFLICT | SITE_VACANCY_SLUG_CONFLICT`, `409 SITE_EVENT_START_REQUIRED` (публикация события без `startsAt`), `429 AUTH_RATE_LIMITED`.

### POST /admin/site/images

Тело — байты файла, `Content-Type: image/jpeg` или `image/png`, необязательный заголовок `X-File-Name` (URL-encoded). Тип проверяется по содержимому, ширина и высота читаются из файла. Это существующий механизм файлов проекта (провайдер хранилища + таблица `assets`), без multipart-сессии: картинки маленькие.

```json
{ "data": { "assetId": "1", "url": "https://api.everestlc.tj/api/v1/public/site/images/1", "width": 1200, "height": 630, "mimeType": "image/png", "fileName": "cover.png", "sizeBytes": 183422, "createdAt": "2026-11-28T10:10:24.058Z" } }
```

Ошибки: `413 SITE_IMAGE_TOO_LARGE`, `415 SITE_IMAGE_TYPE_INVALID`, `422 SITE_IMAGE_CONTENT_INVALID`, `400 SITE_IMAGE_UPLOAD_FAILED`, `503 STORAGE_NOT_CONFIGURED`. `assetId` вставляется в `coverAssetId`, `imageAssetId`, `thumbnailAssetId`, `hero.imageAssetId`, `seo.ogImageAssetId`; другие ассеты (материалы уроков) не принимаются (`400`, поле с именем ассета).

### Курс (admin)

Запрос `POST /admin/site/courses` (обязательны `slug`, `subjectKey`, `title.ru`):

```json
{
  "slug": "biology",
  "subjectKey": "biology",
  "format": "hybrid",
  "coverAssetId": "1",
  "platformCourseId": null,
  "title": { "ru": "Биология", "tj": "Биология", "en": "Biology" },
  "summary": { "ru": "Системная подготовка..." },
  "description": { "ru": "Курс проходит всю школьную биологию..." },
  "audience": { "ru": "Школьники и абитуриенты" },
  "duration": { "ru": "9 месяцев", "tj": "9 моҳ", "en": "9 months" },
  "topics": { "ru": ["Цитология", "Генетика"] },
  "learn": { "ru": ["Строение и функции клетки"] },
  "howItWorks": { "ru": ["Занятия с преподавателем в группе"] },
  "program": { "ru": [{ "title": "Клетка", "items": ["Строение клетки", "Обмен веществ"] }] },
  "coverAlt": { "ru": "Ученик с микроскопом" },
  "seo": { "title": { "ru": "Биология — подготовка к НЦТ" }, "description": { "ru": "..." } }
}
```

Ответ (так же для GET/PATCH/publish/unpublish; списки сокращены):

```json
{
  "data": {
    "id": "1", "status": "published", "order": 1,
    "slug": "biology", "subjectKey": "biology", "format": "hybrid",
    "coverAssetId": "1",
    "cover": { "assetId": "1", "url": "https://api.everestlc.tj/api/v1/public/site/images/1", "width": 1200, "height": 630, "mimeType": "image/png" },
    "platformCourseId": null,
    "title": { "ru": "Биология", "tj": "Биология", "en": "Biology" },
    "summary": { "ru": "Системная подготовка по биологии: ...", "tj": "Омодагии муназзам ...", "en": "Structured biology preparation: ..." },
    "description": { "ru": "...", "tj": "...", "en": "..." },
    "audience": { "ru": "Школьники и абитуриенты", "tj": "Хонандагон ва довталабон", "en": "School students and university applicants" },
    "duration": { "ru": "9 месяцев", "tj": "9 моҳ", "en": "9 months" },
    "label": { "ru": "Подготовка к НЦТ", "tj": "Омодагӣ ба ММТ", "en": "NCT preparation" },
    "topics": { "ru": ["Цитология", "Генетика", "Анатомия"], "tj": ["Ситология", "Генетика", "Анатомия"], "en": ["Cytology", "Genetics", "Anatomy"] },
    "learn": { "ru": ["..."], "tj": ["..."], "en": ["..."] },
    "howItWorks": { "ru": ["..."], "tj": ["..."], "en": ["..."] },
    "program": { "ru": [{ "title": "Основы биологии", "items": ["Уровни организации живого", "Методы биологии"] }], "tj": [], "en": [] },
    "coverAlt": { "ru": null, "tj": null, "en": null },
    "seo": { "title": { "ru": "Биология — подготовка к НЦТ", "tj": null, "en": null }, "description": { "ru": null, "tj": null, "en": null } },
    "publishedAt": "2026-11-28T10:10:20.061Z", "createdAt": "2026-11-28T10:10:20.061Z", "updatedAt": "2026-11-28T10:10:24.140Z"
  }
}
```

Правила: `slug` — `^[a-z0-9]+(-[a-z0-9]+)*$`, до 64 символов, уникален (менять можно, но ссылки сайта сменятся). Списки — до 30 элементов, строки — до 300 символов; `program[].title` обязателен.

### Вакансия (admin)

Запрос (обязательны `slug`, `title.ru`):

```json
{
  "slug": "biology-teacher",
  "employmentType": "FULL_TIME",
  "salary": { "min": 4000, "max": 6000, "currency": "TJS" },
  "datePosted": "2026-11-28",
  "validThrough": "2027-01-31",
  "title": { "ru": "Преподаватель биологии", "tj": "Омӯзгори биология", "en": "Biology teacher" },
  "location": { "ru": "Душанбе", "en": "Dushanbe" },
  "description": { "ru": "Работа с мотивированными школьниками и подготовка к НЦТ." },
  "requirements": { "ru": ["Профильное образование"] },
  "conditions": { "ru": ["Официальное оформление"] }
}
```

Ответ:

```json
{
  "data": {
    "id": "1", "status": "published", "order": 1,
    "slug": "biology-teacher", "employmentType": "FULL_TIME",
    "salary": { "min": 4000, "max": 6000, "currency": "TJS" },
    "datePosted": "2026-11-28", "validThrough": "2027-01-31",
    "title": { "ru": "Преподаватель биологии", "tj": "Омӯзгори биология", "en": "Biology teacher" },
    "location": { "ru": "Душанбе", "tj": "Душанбе", "en": "Dushanbe" },
    "description": { "ru": "...", "tj": "...", "en": "..." },
    "requirements": { "ru": ["Профильное образование", "Умение объяснять сложное"], "tj": ["..."], "en": ["..."] },
    "conditions": { "ru": ["Официальное оформление"], "tj": [], "en": [] },
    "publishedAt": "2026-11-28T10:10:24.338Z", "createdAt": "2026-11-28T10:10:20.061Z", "updatedAt": "2026-11-28T10:10:24.338Z"
  }
}
```

`salary: null` убирает зарплату. Даты — `YYYY-MM-DD`; `validThrough` не раньше `datePosted`.

### Событие (admin)

Запрос (обязателен `title.ru`):

```json
{
  "type": "mock-nct",
  "mode": "offline",
  "startsAt": "2026-12-12T10:00",
  "endsAt": "2026-12-12T13:00",
  "imageAssetId": "1",
  "title": { "ru": "Пробный НЦТ", "tj": "ММТ-и озмоишӣ", "en": "Practice NCT" },
  "description": { "ru": "..." },
  "location": { "ru": "Душанбе, учебный центр EVEREST" },
  "imageAlt": { "ru": "Ученики на пробном НЦТ" }
}
```

`startsAt`/`endsAt`: ISO 8601 со смещением (`2026-12-12T10:00:00+05:00`, `...Z`) или локальное время без смещения — оно читается как Asia/Dushanbe. `endsAt` не раньше `startsAt`.

Ответ:

```json
{
  "data": {
    "id": "2", "status": "published", "order": 2, "type": "mock-nct", "mode": "offline",
    "startsAt": "2026-12-12T10:00:00+05:00", "endsAt": "2026-12-12T13:00:00+05:00", "timeZone": "Asia/Dushanbe",
    "imageAssetId": "1",
    "image": { "assetId": "1", "url": "https://api.everestlc.tj/api/v1/public/site/images/1", "width": 1200, "height": 630, "mimeType": "image/png" },
    "title": { "ru": "Пробный НЦТ", "tj": "ММТ-и озмоишӣ", "en": "Practice NCT" },
    "description": { "ru": "...", "tj": "...", "en": "..." },
    "location": { "ru": "Душанбе, учебный центр EVEREST", "tj": null, "en": null },
    "imageAlt": { "ru": null, "tj": null, "en": null },
    "publishedAt": "2026-11-28T10:10:24.383Z", "createdAt": "2026-11-28T10:10:20.061Z", "updatedAt": "2026-11-28T10:10:24.383Z"
  }
}
```

### Видео (admin)

Запрос (обязательны `url`, `title.ru`):

```json
{
  "url": "https://youtu.be/dQw4w9WgXcQ",
  "thumbnailAssetId": null,
  "duration": "PT3M33S",
  "uploadDate": null,
  "placement": "course",
  "courseSlug": "biology",
  "title": { "ru": "Как проходит занятие", "en": "A class at EVEREST" },
  "description": { "ru": "Фрагмент урока биологии" },
  "thumbnailAlt": { "ru": "Кадр урока" }
}
```

`url`: YouTube (`youtube.com/watch?v=`, `/embed/`, `/shorts/`, `/live/`, `youtu.be/`; www/m/music), Vimeo (`vimeo.com/<id>`, `player.vimeo.com/video/<id>`) или https-файл `.mp4`/`.webm`. Остальное → `400`, `field: "url"`. `provider` и `videoId` определяются по ссылке, YouTube и Vimeo сохраняются в канонической форме. `placement: "course"` требует `courseSlug` существующего курса сайта; для `home` `courseSlug` не задаётся. Если курс удалить, видео остаётся с `courseSlug: null`.

Ответ:

```json
{
  "data": {
    "id": "1", "status": "published", "order": 1,
    "provider": "youtube", "videoId": "dQw4w9WgXcQ", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "thumbnailAssetId": null, "thumbnail": null,
    "duration": "PT3M33S", "uploadDate": "2026-11-28",
    "placement": "course", "courseSlug": "biology",
    "title": { "ru": "Как проходит занятие", "tj": null, "en": "A class at EVEREST" },
    "description": { "ru": "Фрагмент урока биологии", "tj": null, "en": null },
    "thumbnailAlt": { "ru": null, "tj": null, "en": null },
    "publishedAt": "2026-11-28T10:10:24.420Z", "createdAt": "2026-11-28T10:10:24.399Z", "updatedAt": "2026-11-28T10:10:24.420Z"
  }
}
```

### Настройки (admin): GET /admin/site/settings, PUT /admin/site/settings

`PUT` сохраняет только присланные поля, остальные не меняются; внутри `{ ru, tj, en }` меняются только присланные языки. Настройки всегда живые (без черновика).

Запрос:

```json
{
  "phones": [{ "number": "+992 90 123 45 67", "label": { "ru": "Ресепшн", "tj": "Қабулгоҳ", "en": "Reception" } }],
  "whatsapp": "901234567",
  "whatsappTemplate": { "ru": "Здравствуйте! Хочу узнать о курсах EVEREST" },
  "whatsappCourseTemplate": { "ru": "Здравствуйте! Хочу узнать о курсе «{course}» в EVEREST" },
  "telegram": "@everest_lc",
  "instagram": "https://instagram.com/everest.lc",
  "playMarketUrl": null,
  "address": { "ru": "Душанбе, ул. Примерная, 1", "tj": "Душанбе, кӯчаи Намунавӣ, 1" },
  "geo": { "lat": 38.5598, "lng": 68.787 },
  "hours": [{ "days": ["mon", "tue", "wed", "thu", "fri"], "opens": "08:00", "closes": "18:00" }],
  "stats": { "enabled": false, "items": [{ "value": "1 200+", "label": { "ru": "учеников доверяют EVEREST" } }] },
  "hero": { "title": { "ru": "..." }, "subtitle": { "ru": "..." }, "primaryCta": { "ru": "Записаться на курс" }, "secondaryCta": { "ru": "Узнать больше" }, "imageAlt": { "ru": "..." }, "imageAssetId": "1" },
  "whyEverest": { "ru": [{ "title": "Сильные преподаватели", "text": "..." }] },
  "stages": { "ru": [{ "title": "Выбор направления", "text": "..." }] },
  "seo": { "title": { "ru": "..." }, "description": { "ru": "..." }, "ogImageAlt": { "ru": "..." }, "ogImageAssetId": "1" }
}
```

Правила:
- Телефоны: E.164; 9 цифр без кода → `+992…`, `992…` и `00992…` тоже принимаются; у +992 ровно 9 цифр после кода; до 10 номеров, без повторов; `label` необязателен. `whatsapp` по тем же правилам, `null` очищает.
- `telegram`: username, `@username` или ссылка `t.me/…`; `instagram`: username, `@username` или ссылка `instagram.com/…`; в ответах — полные URL.
- `playMarketUrl`: только `https://play.google.com/store/apps/…` или `null`.
- `hours`: `days` из `mon..sun`, каждый день не больше одного раза за все записи, `opens`/`closes` — `HH:mm`, `closes` позже `opens`. `[]` — часы не указаны.
- Шаблоны WhatsApp: плейсхолдеры только `{course}`, `{vacancy}`, `{event}`.
- `stats.items`: `value` до 32 символов, `label.ru` обязателен. `stats.items` заменяет весь список.

Ответ (списки сокращены):

```json
{
  "data": {
    "phones": [{ "number": "+992901234567", "label": { "ru": "Ресепшн", "tj": "Қабулгоҳ", "en": "Reception" } }],
    "whatsapp": "+992901234567",
    "whatsappTemplate": { "ru": "Здравствуйте! Хочу узнать о курсах EVEREST", "tj": "Ассалому алейкум! ...", "en": "Hello! I would like to learn about EVEREST courses" },
    "whatsappCourseTemplate": { "ru": "Здравствуйте! Хочу узнать о курсе «{course}» в EVEREST", "tj": "...", "en": "Hello! I would like to learn about the {course} course at EVEREST" },
    "telegram": "https://t.me/everest_lc",
    "instagram": "https://www.instagram.com/everest.lc",
    "playMarketUrl": null,
    "address": { "ru": "Душанбе, ул. Примерная, 1", "tj": "Душанбе, кӯчаи Намунавӣ, 1", "en": null },
    "geo": { "lat": 38.5598, "lng": 68.787 },
    "hours": [{ "days": ["mon", "tue", "wed", "thu", "fri"], "opens": "08:00", "closes": "18:00" }, { "days": ["sat"], "opens": "09:00", "closes": "14:00" }],
    "stats": { "enabled": false, "items": [{ "value": "1 200+", "label": { "ru": "учеников доверяют EVEREST", "tj": "хонанда ба EVEREST боварӣ доранд", "en": "students trust EVEREST" } }] },
    "hero": {
      "title": { "ru": "Готовим сегодня к большим возможностям завтра", "tj": "...", "en": "Preparing today for bigger opportunities tomorrow" },
      "subtitle": { "ru": "...", "tj": "...", "en": "..." },
      "primaryCta": { "ru": "Записаться на курс", "tj": "Ба курс сабти ном шудан", "en": "Sign up for a course" },
      "secondaryCta": { "ru": "Узнать больше", "tj": "Бештар маълумот", "en": "Learn more" },
      "imageAlt": { "ru": "Ученики EVEREST во время занятия", "tj": "...", "en": "EVEREST students in class" },
      "imageAssetId": "1",
      "image": { "assetId": "1", "url": "https://api.everestlc.tj/api/v1/public/site/images/1", "width": 1200, "height": 630, "mimeType": "image/png" }
    },
    "whyEverest": { "ru": [{ "title": "Сильные преподаватели", "text": "..." }], "tj": [], "en": [] },
    "stages": { "ru": [{ "title": "Выбор направления", "text": "..." }], "tj": [], "en": [] },
    "seo": {
      "title": { "ru": "EVEREST — подготовка к НЦТ и поступлению", "tj": "...", "en": "..." },
      "description": { "ru": "...", "tj": "...", "en": "..." },
      "ogImageAlt": { "ru": null, "tj": null, "en": null },
      "ogImageAssetId": "1",
      "ogImage": { "assetId": "1", "url": "https://api.everestlc.tj/api/v1/public/site/images/1", "width": 1200, "height": 630, "mimeType": "image/png" }
    },
    "updatedAt": "2026-11-28T10:10:24.440Z"
  }
}
```

### PATCH /admin/site/{entity}/order

Запрос: `{ "ids": ["4", "3", "2", "1"] }` — все id сущности ровно по разу. Ответ: `{ "data": { "items": [ <элементы в новом порядке, order 1..n> ] } }`. Неполный или повторяющийся список → `400`, `field: "ids"`.

### DELETE /admin/site/{entity}/:id

Ответ: `{ "data": { "id": "5", "status": "deleted" } }`.

## Вебхук ревалидации

- `POST {SITE_REVALIDATE_URL}` (это `{MARKETING_ORIGIN}/api/revalidate`), заголовки `Content-Type: application/json` и `x-revalidate-secret: {SITE_REVALIDATE_SECRET}`, тело `{ "tags": [...] }`, таймаут 3 с (`SITE_REVALIDATE_TIMEOUT_MS`). Ответ 2xx — успех, всё остальное — ошибка.
- Теги: всегда `site`, плюс `site:settings`, `site:courses` (+ `site:course:{slug}`, при смене slug — старый и новый), `site:vacancies`, `site:events`, `site:videos` (+ `site:course:{slug}` для видео курса).
- Когда: изменение, удаление, снятие и публикация опубликованного элемента, перестановка в сущности с опубликованными элементами, любое сохранение настроек. Изменения черновиков вебхук не вызывают.
- Как: задача `site.revalidate` кладётся в `background_jobs` в той же транзакции, что и сохранение; отправляет `worker:jobs` (обычно через несколько секунд). При ошибке — 3 повтора с бэкоффом 30 с, 60 с, 120 с, потом задача остаётся `failed`. Сохранение никогда не ждёт вебхук и не ломается из-за него.
- Если `SITE_REVALIDATE_URL` или `SITE_REVALIDATE_SECRET` не заданы, задача не создаётся.

Примеры тел, которые сделал прогон: `{"tags":["site","site:courses","site:course:biology"]}`, `{"tags":["site","site:vacancies"]}`, `{"tags":["site","site:videos","site:course:biology"]}`, `{"tags":["site","site:settings"]}`.

## Сид (миграция `20261128020000000_seed-site-content`)

- 4 курса (biology, chemistry, physics, tajik) — опубликованы, `format: hybrid`, `subjectKey` = slug, программа в формате `{ title, items[] }`, «Для кого» у всех — «Школьники и абитуриенты». Тексты ru/tj/en.
- «Почему EVEREST» (6) и «Этапы подготовки» (6) — заполнены. Показатели (4) сохранены, `stats.enabled = false`.
- 3 вакансии (`biology-teacher`, `chemistry-teacher`, `client-manager`, `FULL_TIME`, без зарплаты) и 3 события (`enrollment`, `mock-nct`, `open-lesson`, без даты) — черновики.
- Контакты пустые. В текстах «Онлайн-платформа», «ИИ-помощник» (tj: «Ёрдамчии AI», как в приложении); «Student Platform» и «preview» в сид не попали. Эти строки остаются в коде фронтенда (`PlatformMiniCard`, блок платформы) — их нужно поправить там.
- Идемпотентно: курсы и вакансии по slug, события — только в пустую таблицу, переводы настроек — только для отсутствующего языка. Таджикские тексты на проверку носителем: `docs/i18n-review-tj.md`.

## Env

| Переменная | Назначение |
|---|---|
| `API_PUBLIC_URL` | стабильный origin API для абсолютных ссылок на картинки (`https://api.everestlc.tj`) |
| `SITE_REVALIDATE_URL` | `{MARKETING_ORIGIN}/api/revalidate` |
| `SITE_REVALIDATE_SECRET` | секрет для `x-revalidate-secret` |
| `SITE_REVALIDATE_TIMEOUT_MS` | таймаут запроса, по умолчанию 3000 |
| `SITE_CACHE_MAX_AGE_SECONDS` | max-age публичных ответов, по умолчанию 60 |
