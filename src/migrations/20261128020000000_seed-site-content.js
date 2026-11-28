// Seed of the marketing site with the content that was hard-coded in the frontend
// (everestlc, src/entities/marketing and src/views/marketing). Idempotent: courses and
// vacancies are keyed by slug, events are inserted only into an empty table, settings
// translations only for a missing language, and settings values only while still empty.
// - 4 courses: published, format hybrid ("Онлайн и офлайн"). Chemistry and physics
//   "for whom" is "Школьники и абитуриенты" (the frontend had "Подготовка к НЦТ").
// - "Why EVEREST" and the preparation stages: filled. Stats: filled, stats_enabled stays false.
// - 3 vacancies and 3 events: draft (the frontend marked them as demo).
// - Contacts: empty. Tajik texts are a draft; see docs/i18n-review-tj.md.
// Seeded rows have created_by NULL; down removes only those rows.

const howItWorks = {
   ru: [
      'Занятия с преподавателем в группе',
      'Практика и разбор заданий',
      'Обратная связь по темам и результатам',
      'Повторение в онлайн-платформе: уроки, тесты, ИИ-помощник и прогресс',
   ],
   tg: [
      'Дарсҳо бо омӯзгор дар гурӯҳ',
      'Машқ ва таҳлили супоришҳо',
      'Бозгашти фикр аз рӯи мавзӯъҳо ва натиҷаҳо',
      'Такрор дар платформаи онлайн: дарсҳо, тестҳо, Ёрдамчии AI ва пешрафт',
   ],
   en: [
      'Group classes with a teacher',
      'Practice and task reviews',
      'Feedback on topics and results',
      'Revision on the online platform: lessons, tests, AI assistant and progress',
   ],
}

const common = {
   ru: { label: 'Подготовка к НЦТ', audience: 'Школьники и абитуриенты' },
   tg: { label: 'Омодагӣ ба ММТ', audience: 'Хонандагон ва довталабон' },
   en: { label: 'NCT preparation', audience: 'School students and university applicants' },
}

const program = (pairs) => pairs.map(([title, items]) => ({ title, items }))

const courses = [
   {
      slug: 'biology', subjectKey: 'biology', position: 1,
      ru: {
         title: 'Биология',
         summary: 'Системная подготовка по биологии: от клетки до генетики и здоровья человека.',
         description: 'Курс проходит всю школьную биологию по порядку: теория, разбор задач и задания в формате НЦТ на каждом занятии.',
         topics: ['Цитология', 'Генетика', 'Анатомия'],
         learn: [
            'Строение и функции клетки',
            'Законы наследственности и решение генетических задач',
            'Эволюцию и многообразие живого',
            'Анатомию и физиологию человека',
            'Задания в формате НЦТ',
         ],
         program: program([
            ['Основы биологии', ['Уровни организации живого', 'Методы биологии']],
            ['Клетка', ['Строение клетки', 'Обмен веществ', 'Деление клетки']],
            ['Генетика', ['Законы Менделя', 'Наследственность и изменчивость', 'Генетические задачи']],
            ['Эволюция', ['Происхождение жизни', 'Эволюция живого', 'Экология']],
            ['Человек и здоровье', ['Анатомия человека', 'Физиология систем органов']],
         ]),
      },
      tg: {
         title: 'Биология',
         summary: 'Омодагии муназзам аз биология: аз ҳуҷайра то генетика ва саломатии инсон.',
         description: 'Курс тамоми биологияи мактабиро бо тартиб мегузарад: назария, таҳлили масъалаҳо ва супоришҳо дар формати ММТ дар ҳар дарс.',
         topics: ['Ситология', 'Генетика', 'Анатомия'],
         learn: [
            'Сохт ва вазифаҳои ҳуҷайра',
            'Қонунҳои ирсият ва ҳалли масъалаҳои генетикӣ',
            'Эволютсия ва гуногунии олами зинда',
            'Анатомия ва физиологияи инсон',
            'Супоришҳо дар формати ММТ',
         ],
         program: program([
            ['Асосҳои биология', ['Сатҳҳои ташкили олами зинда', 'Усулҳои биология']],
            ['Ҳуҷайра', ['Сохти ҳуҷайра', 'Мубодилаи моддаҳо', 'Тақсимшавии ҳуҷайра']],
            ['Генетика', ['Қонунҳои Мендел', 'Ирсият ва тағйирпазирӣ', 'Масъалаҳои генетикӣ']],
            ['Эволютсия', ['Пайдоиши ҳаёт', 'Эволютсияи олами зинда', 'Экология']],
            ['Инсон ва саломатӣ', ['Анатомияи инсон', 'Физиологияи системаҳои узвҳо']],
         ]),
      },
      en: {
         title: 'Biology',
         summary: 'Structured biology preparation: from the cell to genetics and human health.',
         description: 'The course covers school biology in order: theory, worked problems and NCT-format tasks in every class.',
         topics: ['Cytology', 'Genetics', 'Anatomy'],
         learn: [
            'Cell structure and functions',
            'Laws of heredity and genetics problems',
            'Evolution and the diversity of life',
            'Human anatomy and physiology',
            'Tasks in the NCT format',
         ],
         program: program([
            ['Biology basics', ['Levels of organisation of life', 'Methods of biology']],
            ['The cell', ['Cell structure', 'Metabolism', 'Cell division']],
            ['Genetics', ['Mendel’s laws', 'Heredity and variation', 'Genetics problems']],
            ['Evolution', ['The origin of life', 'Evolution of living things', 'Ecology']],
            ['Humans and health', ['Human anatomy', 'Physiology of organ systems']],
         ]),
      },
   },
   {
      slug: 'chemistry', subjectKey: 'chemistry', position: 2,
      ru: {
         title: 'Химия',
         summary: 'Понимание веществ, реакций и закономерностей вместо механического заучивания.',
         description: 'От строения атома до органической химии: объясняем, почему вещества ведут себя так, и учим решать расчётные задачи НЦТ.',
         topics: ['Атом', 'Реакции', 'Органика'],
         learn: [
            'Строение атома и периодический закон',
            'Типы химических реакций и уравнения',
            'Свойства неорганических веществ',
            'Основы органической химии',
            'Решение расчётных задач',
         ],
         program: program([
            ['Основы химии', ['Вещества и их состав', 'Основные понятия химии']],
            ['Строение атома', ['Строение атома', 'Химическая связь', 'Периодическая система']],
            ['Химические реакции', ['Типы реакций', 'Скорость и равновесие', 'Растворы']],
            ['Неорганическая химия', ['Классы неорганических соединений', 'Их свойства']],
            ['Органическая химия', ['Углеводороды', 'Функциональные группы', 'Полимеры']],
         ]),
      },
      tg: {
         title: 'Химия',
         summary: 'Фаҳмидани моддаҳо, реаксияҳо ва қонуниятҳо ба ҷои аз ёд кардани механикӣ.',
         description: 'Аз сохти атом то химияи органикӣ: мефаҳмонем, ки чаро моддаҳо чунин рафтор мекунанд, ва ҳалли масъалаҳои ҳисобии ММТ-ро меомӯзонем.',
         topics: ['Атом', 'Реаксияҳо', 'Химияи органикӣ'],
         learn: [
            'Сохти атом ва қонуни даврӣ',
            'Намудҳои реаксияҳои химиявӣ ва муодилаҳо',
            'Хосиятҳои моддаҳои ғайриорганикӣ',
            'Асосҳои химияи органикӣ',
            'Ҳалли масъалаҳои ҳисобӣ',
         ],
         program: program([
            ['Асосҳои химия', ['Моддаҳо ва таркиби онҳо', 'Мафҳумҳои асосии химия']],
            ['Сохти атом', ['Сохти атом', 'Банди химиявӣ', 'Системаи даврӣ']],
            ['Реаксияҳои химиявӣ', ['Намудҳои реаксияҳо', 'Суръат ва мувозинат', 'Маҳлулҳо']],
            ['Химияи ғайриорганикӣ', ['Синфҳои пайвастҳои ғайриорганикӣ', 'Хосиятҳои онҳо']],
            ['Химияи органикӣ', ['Карбогидрогенҳо', 'Гурӯҳҳои функсионалӣ', 'Полимерҳо']],
         ]),
      },
      en: {
         title: 'Chemistry',
         summary: 'Understanding substances, reactions and patterns instead of rote memorisation.',
         description: 'From atomic structure to organic chemistry: we explain why substances behave as they do and teach NCT calculation problems.',
         topics: ['The atom', 'Reactions', 'Organic chemistry'],
         learn: [
            'Atomic structure and the periodic law',
            'Types of chemical reactions and equations',
            'Properties of inorganic substances',
            'Basics of organic chemistry',
            'Solving calculation problems',
         ],
         program: program([
            ['Chemistry basics', ['Substances and their composition', 'Core concepts of chemistry']],
            ['Atomic structure', ['The atom', 'Chemical bonding', 'The periodic table']],
            ['Chemical reactions', ['Reaction types', 'Rate and equilibrium', 'Solutions']],
            ['Inorganic chemistry', ['Classes of inorganic compounds', 'Their properties']],
            ['Organic chemistry', ['Hydrocarbons', 'Functional groups', 'Polymers']],
         ]),
      },
   },
   {
      slug: 'physics', subjectKey: 'physics', position: 3,
      ru: {
         title: 'Физика',
         summary: 'Теория, задачи и физические законы в понятной последовательной программе.',
         description: 'Разбираем законы физики на понятных примерах и много решаем: от механики до оптики, с задачами в формате НЦТ.',
         topics: ['Механика', 'Электричество', 'Оптика'],
         learn: [
            'Законы механики и движения',
            'Молекулярную физику и термодинамику',
            'Электричество и магнетизм',
            'Оптику и волны',
            'Методы решения задач',
         ],
         program: program([
            ['Введение', ['Физические величины', 'Измерения и единицы']],
            ['Механика', ['Кинематика', 'Динамика', 'Законы сохранения']],
            ['Молекулярная физика', ['Строение вещества', 'Газовые законы', 'Термодинамика']],
            ['Электричество', ['Электростатика', 'Постоянный ток', 'Магнитное поле']],
            ['Оптика', ['Отражение и преломление', 'Линзы', 'Волновая оптика']],
         ]),
      },
      tg: {
         title: 'Физика',
         summary: 'Назария, масъалаҳо ва қонунҳои физикӣ дар барномаи фаҳмо ва пайдарпай.',
         description: 'Қонунҳои физикаро дар мисолҳои фаҳмо таҳлил мекунем ва бисёр масъала ҳал мекунем: аз механика то оптика, бо масъалаҳо дар формати ММТ.',
         topics: ['Механика', 'Барқ', 'Оптика'],
         learn: [
            'Қонунҳои механика ва ҳаракат',
            'Физикаи молекулавӣ ва термодинамика',
            'Барқ ва магнетизм',
            'Оптика ва мавҷҳо',
            'Усулҳои ҳалли масъалаҳо',
         ],
         program: program([
            ['Муқаддима', ['Бузургиҳои физикӣ', 'Ченкунӣ ва воҳидҳо']],
            ['Механика', ['Кинематика', 'Динамика', 'Қонунҳои бақо']],
            ['Физикаи молекулавӣ', ['Сохти модда', 'Қонунҳои газҳо', 'Термодинамика']],
            ['Барқ', ['Электростатика', 'Ҷараёни доимӣ', 'Майдони магнитӣ']],
            ['Оптика', ['Инъикос ва шикаст', 'Линзаҳо', 'Оптикаи мавҷӣ']],
         ]),
      },
      en: {
         title: 'Physics',
         summary: 'Theory, problems and physical laws in a clear, step-by-step programme.',
         description: 'We work through the laws of physics with clear examples and plenty of problems, from mechanics to optics, in the NCT format.',
         topics: ['Mechanics', 'Electricity', 'Optics'],
         learn: [
            'The laws of mechanics and motion',
            'Molecular physics and thermodynamics',
            'Electricity and magnetism',
            'Optics and waves',
            'Problem-solving methods',
         ],
         program: program([
            ['Introduction', ['Physical quantities', 'Measurement and units']],
            ['Mechanics', ['Kinematics', 'Dynamics', 'Conservation laws']],
            ['Molecular physics', ['Structure of matter', 'Gas laws', 'Thermodynamics']],
            ['Electricity', ['Electrostatics', 'Direct current', 'The magnetic field']],
            ['Optics', ['Reflection and refraction', 'Lenses', 'Wave optics']],
         ]),
      },
   },
   {
      slug: 'tajik', subjectKey: 'tajik', position: 4,
      ru: {
         title: 'Таджикский язык',
         summary: 'Грамматика, лексика, орфография и уверенная работа с текстом.',
         description: 'Системно повторяем правила языка и много работаем с текстом, чтобы уверенно справляться с заданиями НЦТ.',
         topics: ['Орфография', 'Морфология', 'Синтаксис'],
         learn: [
            'Правила орфографии и пунктуации',
            'Части речи и их формы',
            'Строение предложения',
            'Лексику и стилистику',
            'Анализ и понимание текста',
         ],
         program: program([
            ['Фонетика', ['Звуки и буквы', 'Ударение', 'Правила произношения']],
            ['Лексика', ['Значение слов', 'Синонимы', 'Фразеология']],
            ['Морфология', ['Части речи', 'Грамматические формы']],
            ['Синтаксис', ['Словосочетание', 'Простое предложение', 'Сложное предложение']],
            ['Работа с текстом', ['Понимание текста', 'Анализ', 'Редактирование']],
         ]),
      },
      tg: {
         title: 'Забони тоҷикӣ',
         summary: 'Грамматика, луғат, имло ва кори боварибахш бо матн.',
         description: 'Қоидаҳои забонро муназзам такрор мекунем ва бо матн бисёр кор мекунем, то супоришҳои ММТ-ро бо боварӣ иҷро кунед.',
         topics: ['Имло', 'Морфология', 'Синтаксис'],
         learn: [
            'Қоидаҳои имло ва аломатгузорӣ',
            'Ҳиссаҳои нутқ ва шаклҳои онҳо',
            'Сохти ҷумла',
            'Лексика ва услубшиносӣ',
            'Таҳлил ва фаҳмиши матн',
         ],
         program: program([
            ['Фонетика', ['Овозҳо ва ҳарфҳо', 'Зада', 'Қоидаҳои талаффуз']],
            ['Лексика', ['Маънои калимаҳо', 'Синонимҳо', 'Фразеология']],
            ['Морфология', ['Ҳиссаҳои нутқ', 'Шаклҳои грамматикӣ']],
            ['Синтаксис', ['Ибора', 'Ҷумлаи сода', 'Ҷумлаи мураккаб']],
            ['Кор бо матн', ['Фаҳмиши матн', 'Таҳлил', 'Таҳрир']],
         ]),
      },
      en: {
         title: 'Tajik language',
         summary: 'Grammar, vocabulary, spelling and confident work with texts.',
         description: 'We revise the rules of the language step by step and work a lot with texts, so the NCT tasks feel familiar.',
         topics: ['Spelling', 'Morphology', 'Syntax'],
         learn: [
            'Spelling and punctuation rules',
            'Parts of speech and their forms',
            'Sentence structure',
            'Vocabulary and style',
            'Reading and analysing texts',
         ],
         program: program([
            ['Phonetics', ['Sounds and letters', 'Stress', 'Pronunciation rules']],
            ['Vocabulary', ['Word meanings', 'Synonyms', 'Set phrases']],
            ['Morphology', ['Parts of speech', 'Grammatical forms']],
            ['Syntax', ['Phrases', 'Simple sentences', 'Complex sentences']],
            ['Working with texts', ['Understanding a text', 'Analysis', 'Editing']],
         ]),
      },
   },
]

const vacancies = [
   {
      slug: 'biology-teacher', position: 1,
      ru: {
         title: 'Преподаватель биологии', location: 'Душанбе',
         description: 'Работа с мотивированными школьниками и подготовка к НЦТ.',
         requirements: ['Профильное образование', 'Умение объяснять сложное'],
      },
      tg: {
         title: 'Омӯзгори биология', location: 'Душанбе',
         description: 'Кор бо хонандагони ҳавасманд ва омодагӣ ба ММТ.',
         requirements: ['Таҳсилоти касбӣ аз рӯи фан', 'Қобилияти фаҳмонидани мавзӯъҳои мураккаб'],
      },
      en: {
         title: 'Biology teacher', location: 'Dushanbe',
         description: 'Work with motivated school students and prepare them for the NCT.',
         requirements: ['A degree in the subject', 'Ability to explain complex topics'],
      },
   },
   {
      slug: 'chemistry-teacher', position: 2,
      ru: {
         title: 'Преподаватель химии', location: 'Душанбе',
         description: 'Системное преподавание химии и практическая подготовка.',
         requirements: ['Профильное образование', 'Опыт преподавания приветствуется'],
      },
      tg: {
         title: 'Омӯзгори химия', location: 'Душанбе',
         description: 'Таълими муназзами химия ва омодагии амалӣ.',
         requirements: ['Таҳсилоти касбӣ аз рӯи фан', 'Таҷрибаи омӯзгорӣ афзалият дорад'],
      },
      en: {
         title: 'Chemistry teacher', location: 'Dushanbe',
         description: 'Structured chemistry teaching and practical preparation.',
         requirements: ['A degree in the subject', 'Teaching experience is a plus'],
      },
   },
   {
      slug: 'client-manager', position: 3,
      ru: {
         title: 'Менеджер по работе с клиентами', location: 'Душанбе',
         description: 'Помощь семьям в выборе учебной программы.',
         requirements: ['Грамотная речь', 'Клиентоориентированность'],
      },
      tg: {
         title: 'Менеҷери кор бо мизоҷон', location: 'Душанбе',
         description: 'Кумак ба оилаҳо дар интихоби барномаи таълимӣ.',
         requirements: ['Нутқи саводнок', 'Муносибати хуб бо мизоҷон'],
      },
      en: {
         title: 'Client relations manager', location: 'Dushanbe',
         description: 'Help families choose a study programme.',
         requirements: ['Clear, correct speech', 'A client-focused attitude'],
      },
   },
]

const events = [
   {
      type: 'enrollment', position: 1,
      ru: { title: 'Новый набор', description: 'Информация о старте групп будет опубликована после подтверждения.' },
      tg: { title: 'Қабули нав', description: 'Маълумот дар бораи оғози гурӯҳҳо пас аз тасдиқ нашр мешавад.' },
      en: { title: 'New intake', description: 'Group start dates will be published once confirmed.' },
   },
   {
      type: 'mock-nct', position: 2,
      ru: { title: 'Пробный НЦТ', description: 'Дата и условия диагностики знаний будут подтверждены центром.' },
      tg: { title: 'ММТ-и озмоишӣ', description: 'Сана ва шартҳои санҷиши дониш аз ҷониби марказ тасдиқ карда мешаванд.' },
      en: { title: 'Practice NCT', description: 'The date and terms of the knowledge check will be confirmed by the centre.' },
   },
   {
      type: 'open-lesson', position: 3,
      ru: { title: 'Открытый урок', description: 'Знакомство с преподавателями и форматом обучения.' },
      tg: { title: 'Дарси кушод', description: 'Шиносоӣ бо омӯзгорон ва формати таълим.' },
      en: { title: 'Open lesson', description: 'Meet the teachers and see how classes work.' },
   },
]

const steps = (pairs) => pairs.map(([title, text]) => ({ title, text }))

const stats = [
   { value: '1 200+', label: { ru: 'учеников доверяют EVEREST', tg: 'хонанда ба EVEREST боварӣ доранд', en: 'students trust EVEREST' } },
   { value: '82%', label: { ru: 'высокие результаты на НЦТ', tg: 'натиҷаҳои баланд дар ММТ', en: 'high NCT results' } },
   { value: '300+', label: { ru: 'поступили в вузы', tg: 'ба донишгоҳҳо дохил шуданд', en: 'admitted to universities' } },
   { value: '150+', label: { ru: 'поступили в медицинские университеты', tg: 'ба донишгоҳҳои тиббӣ дохил шуданд', en: 'admitted to medical universities' } },
]

const settings = {
   ru: {
      whatsappTemplate: 'Здравствуйте! Хочу узнать о курсах EVEREST',
      whatsappCourseTemplate: 'Здравствуйте! Хочу узнать о курсе «{course}» в EVEREST',
      heroTitle: 'Готовим сегодня к большим возможностям завтра',
      heroSubtitle: 'Знания, практика и поступление: четыре направления и единая цифровая среда обучения.',
      heroPrimaryCta: 'Записаться на курс',
      heroSecondaryCta: 'Узнать больше',
      heroImageAlt: 'Ученики EVEREST во время занятия',
      whyEverest: steps([
         ['Сильные преподаватели', 'Понятно объясняют сложные темы и поддерживают учебный ритм.'],
         ['Системная подготовка', 'Последовательная программа вместо разрозненных занятий.'],
         ['Практика НЦТ', 'Задания и пробные форматы для знакомства со структурой экзамена.'],
         ['Контроль прогресса', 'Понятная обратная связь по темам и результатам.'],
         ['Онлайн-платформа', 'Материалы, тесты и повторение доступны между занятиями.'],
         ['Современный подход', 'Очное обучение дополняется цифровыми инструментами.'],
      ]),
      stages: steps([
         ['Выбор направления', 'Определяем цель и подходящую программу.'],
         ['Обучение', 'Изучаем теорию и разбираем примеры.'],
         ['Практика', 'Закрепляем знания на заданиях.'],
         ['Пробный НЦТ', 'Проверяем готовность в формате экзамена.'],
         ['Результат', 'Находим сильные темы и точки роста.'],
         ['Поступление', 'Двигаемся к выбранной образовательной цели.'],
      ]),
      seoTitle: 'EVEREST — подготовка к НЦТ и поступлению',
      seoDescription: 'Учебный центр EVEREST: системная подготовка к НЦТ по биологии, химии, физике и таджикскому языку, практика и онлайн-платформа.',
   },
   tg: {
      whatsappTemplate: 'Ассалому алейкум! Мехоҳам дар бораи курсҳои EVEREST маълумот гирам',
      whatsappCourseTemplate: 'Ассалому алейкум! Мехоҳам дар бораи курси «{course}»-и EVEREST маълумот гирам',
      heroTitle: 'Имрӯз барои имкониятҳои бузурги фардо омода мекунем',
      heroSubtitle: 'Дониш, машқ ва дохилшавӣ: чор самт ва муҳити ягонаи рақамии таълим.',
      heroPrimaryCta: 'Ба курс сабти ном шудан',
      heroSecondaryCta: 'Бештар маълумот',
      heroImageAlt: 'Хонандагони EVEREST ҳангоми дарс',
      whyEverest: steps([
         ['Омӯзгорони қавӣ', 'Мавзӯъҳои мураккабро фаҳмо мефаҳмонанд ва ритми таълимро нигоҳ медоранд.'],
         ['Омодагии муназзам', 'Барномаи пайдарпай ба ҷои дарсҳои пароканда.'],
         ['Машқи ММТ', 'Супоришҳо ва санҷишҳои озмоишӣ барои шинос шудан бо сохтори имтиҳон.'],
         ['Назорати пешрафт', 'Бозгашти фикри фаҳмо аз рӯи мавзӯъҳо ва натиҷаҳо.'],
         ['Платформаи онлайн', 'Мавод, тестҳо ва такрор дар байни дарсҳо дастрасанд.'],
         ['Равиши муосир', 'Таълими ҳузурӣ бо абзорҳои рақамӣ пурра карда мешавад.'],
      ]),
      stages: steps([
         ['Интихоби самт', 'Ҳадаф ва барномаи мувофиқро муайян мекунем.'],
         ['Таълим', 'Назарияро меомӯзем ва мисолҳоро таҳлил мекунем.'],
         ['Машқ', 'Донишро бо супоришҳо мустаҳкам мекунем.'],
         ['ММТ-и озмоишӣ', 'Омодагиро дар формати имтиҳон месанҷем.'],
         ['Натиҷа', 'Мавзӯъҳои қавӣ ва ҷойҳои рушдро меёбем.'],
         ['Дохилшавӣ', 'Ба сӯи ҳадафи таълимии интихобшуда ҳаракат мекунем.'],
      ]),
      seoTitle: 'EVEREST — омодагӣ ба ММТ ва дохилшавӣ',
      seoDescription: 'Маркази таълимии EVEREST: омодагии муназзам ба ММТ аз биология, химия, физика ва забони тоҷикӣ, машқ ва платформаи онлайн.',
   },
   en: {
      whatsappTemplate: 'Hello! I would like to learn about EVEREST courses',
      whatsappCourseTemplate: 'Hello! I would like to learn about the {course} course at EVEREST',
      heroTitle: 'Preparing today for bigger opportunities tomorrow',
      heroSubtitle: 'Knowledge, practice and admission: four subjects and one digital learning environment.',
      heroPrimaryCta: 'Sign up for a course',
      heroSecondaryCta: 'Learn more',
      heroImageAlt: 'EVEREST students in class',
      whyEverest: steps([
         ['Strong teachers', 'They explain complex topics clearly and keep a steady study pace.'],
         ['Structured preparation', 'A consistent programme instead of scattered lessons.'],
         ['NCT practice', 'Tasks and practice tests to get to know the exam format.'],
         ['Progress tracking', 'Clear feedback on topics and results.'],
         ['Online platform', 'Materials, tests and revision between classes.'],
         ['A modern approach', 'Classroom teaching backed by digital tools.'],
      ]),
      stages: steps([
         ['Choosing a direction', 'We set the goal and pick the right programme.'],
         ['Learning', 'We study the theory and work through examples.'],
         ['Practice', 'We reinforce knowledge with tasks.'],
         ['Practice NCT', 'We check readiness in the exam format.'],
         ['Results', 'We find strong topics and areas to improve.'],
         ['Admission', 'We move towards the chosen educational goal.'],
      ]),
      seoTitle: 'EVEREST — NCT and university admission preparation',
      seoDescription: 'EVEREST learning centre: structured NCT preparation in biology, chemistry, physics and Tajik, with practice and an online platform.',
   },
}

const languages = ['ru', 'tg', 'en']
const literal = (value) => (value === null || value === undefined
   ? 'NULL'
   : `'${String(value).replaceAll("'", "''")}'`)
const json = (value) => `${literal(JSON.stringify(value ?? []))}::jsonb`

function courseSql(course) {
   const rows = languages.map((language) => {
      const text = { ...common[language], ...course[language] }
      return `(${[
         literal(language), literal(text.title), literal(text.summary), literal(text.description),
         literal(text.audience), literal(text.label), json(text.topics), json(text.learn),
         json(howItWorks[language]), json(text.program),
      ].join(', ')})`
   }).join(',\n       ')
   return `
WITH inserted AS (
   INSERT INTO site_courses (slug, subject_key, format, position, status, published_at)
   VALUES (${literal(course.slug)}, ${literal(course.subjectKey)}, 'hybrid', ${course.position},
      'published', CURRENT_TIMESTAMP)
   ON CONFLICT (slug) DO NOTHING
   RETURNING id
)
INSERT INTO site_course_translations (site_course_id, language_code, title, summary, description,
   audience, label, topics, learn, how_it_works, program)
SELECT inserted.id, value.*
FROM inserted
CROSS JOIN (VALUES
       ${rows}
) AS value (language_code, title, summary, description, audience, label, topics, learn, how_it_works, program);`
}

function vacancySql(vacancy) {
   const rows = languages.map((language) => {
      const text = vacancy[language]
      return `(${[
         literal(language), literal(text.title), literal(text.location), literal(text.description),
         json(text.requirements), json([]),
      ].join(', ')})`
   }).join(',\n       ')
   return `
WITH inserted AS (
   INSERT INTO site_vacancies (slug, employment_type, position, status)
   VALUES (${literal(vacancy.slug)}, 'FULL_TIME', ${vacancy.position}, 'draft')
   ON CONFLICT (slug) DO NOTHING
   RETURNING id
)
INSERT INTO site_vacancy_translations (site_vacancy_id, language_code, title, location, description,
   requirements, conditions)
SELECT inserted.id, value.*
FROM inserted
CROSS JOIN (VALUES
       ${rows}
) AS value (language_code, title, location, description, requirements, conditions);`
}

function eventSql(event) {
   const rows = languages.map((language) => {
      const text = event[language]
      return `(${[literal(language), literal(text.title), literal(text.description)].join(', ')})`
   }).join(',\n       ')
   return `
WITH inserted AS (
   INSERT INTO site_events (event_type, mode, position, status)
   VALUES (${literal(event.type)}, 'offline', ${event.position}, 'draft')
   RETURNING id
)
INSERT INTO site_event_translations (site_event_id, language_code, title, description)
SELECT inserted.id, value.*
FROM inserted
CROSS JOIN (VALUES
       ${rows}
) AS value (language_code, title, description);`
}

// Events have no natural key, so they are seeded only into an empty table.
function eventsSql() {
   return `
DO $$
BEGIN
   IF EXISTS (SELECT 1 FROM site_events) THEN RETURN; END IF;
   ${events.map(eventSql).join('\n')}
END $$;`
}

function settingsSql() {
   const rows = languages.map((language) => {
      const text = settings[language]
      return `(${[
         literal(language), literal(text.whatsappTemplate), literal(text.whatsappCourseTemplate),
         literal(text.heroTitle), literal(text.heroSubtitle), literal(text.heroPrimaryCta),
         literal(text.heroSecondaryCta), literal(text.heroImageAlt), json(text.whyEverest),
         json(text.stages), literal(text.seoTitle), literal(text.seoDescription),
      ].join(', ')})`
   }).join(',\n    ')
   return `
INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

UPDATE site_settings SET stats = ${json(stats)} WHERE id = 1 AND stats = '[]'::jsonb;

INSERT INTO site_settings_translations (language_code, whatsapp_template, whatsapp_course_template,
   hero_title, hero_subtitle, hero_primary_cta, hero_secondary_cta, hero_image_alt, why_everest,
   stages, seo_title, seo_description)
VALUES
    ${rows}
ON CONFLICT (language_code) DO NOTHING;`
}

const seededCourseSlugs = courses.map((course) => literal(course.slug)).join(', ')
const seededVacancySlugs = vacancies.map((vacancy) => literal(vacancy.slug)).join(', ')
const seededEventTitles = events.map((event) => literal(event.ru.title)).join(', ')

export const up = pgm => {
   pgm.sql(`
${courses.map(courseSql).join('\n')}
${vacancies.map(vacancySql).join('\n')}
${eventsSql()}
${settingsSql()}
   `)
}

export const down = pgm => {
   pgm.sql(`
DELETE FROM site_courses WHERE created_by IS NULL AND slug IN (${seededCourseSlugs});

DELETE FROM site_vacancies WHERE created_by IS NULL AND slug IN (${seededVacancySlugs});

DELETE FROM site_events AS event
WHERE event.created_by IS NULL
    AND EXISTS (
        SELECT 1 FROM site_event_translations AS translation
        WHERE translation.site_event_id = event.id AND translation.language_code = 'ru'
            AND translation.title IN (${seededEventTitles})
    );

UPDATE site_settings SET stats = '[]'::jsonb, stats_enabled = false WHERE id = 1;

DELETE FROM site_settings_translations;
   `)
}
