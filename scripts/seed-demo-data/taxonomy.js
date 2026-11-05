// Demo taxonomy: subjects, sections and nested topics. Codes are stable idempotency keys.
// The first two subject codes match the original English seed so a rerun reuses them.

function topic(code, ru, tg, kids = []) {
   return { code, ru, tg, kids }
}

export const subjects = [
   {
      code: 'demo-biology',
      color: 'green',
      titles: { ru: 'Биология', tg: 'Биология', en: 'Biology' },
      sections: [
         {
            code: 'bio-cell',
            ru: 'Клетка',
            tg: 'Ҳуҷайра',
            topics: [
               topic('bio-cell-structure', 'Строение клетки', 'Сохтори ҳуҷайра', [
                  topic('bio-organelles', 'Органоиды', 'Органоидҳо'),
                  topic('bio-membrane', 'Клеточная мембрана', 'Мембранаи ҳуҷайра'),
               ]),
               topic('bio-division', 'Деление клетки', 'Тақсимшавии ҳуҷайра', [
                  topic('bio-mitosis', 'Митоз', 'Митоз'),
                  topic('bio-meiosis', 'Мейоз', 'Мейоз'),
               ]),
            ],
         },
         {
            code: 'bio-genetics',
            ru: 'Генетика',
            tg: 'Генетика',
            topics: [
               topic('bio-dna', 'ДНК и гены', 'ДНК ва генҳо'),
               topic('bio-mendel', 'Законы Менделя', 'Қонунҳои Мендел'),
               topic('bio-mutations', 'Мутации', 'Мутатсияҳо'),
            ],
         },
         {
            code: 'bio-ecology',
            ru: 'Эволюция и экология',
            tg: 'Эволютсия ва экология',
            topics: [
               topic('bio-evolution', 'Эволюция', 'Эволютсия'),
               topic('bio-ecosystems', 'Экосистемы', 'Экосистемаҳо'),
            ],
         },
      ],
   },
   {
      code: 'demo-chemistry',
      color: 'blue',
      titles: { ru: 'Химия', tg: 'Химия', en: 'Chemistry' },
      sections: [
         {
            code: 'chem-matter',
            ru: 'Строение вещества',
            tg: 'Сохти модда',
            topics: [
               topic('chem-atom', 'Строение атома', 'Сохти атом', [
                  topic('chem-periodic', 'Периодический закон', 'Қонуни даврӣ'),
               ]),
               topic('chem-bond', 'Химическая связь', 'Пайвасти химиявӣ'),
               topic('chem-classes', 'Классы неорганических веществ', 'Синфҳои моддаҳои ғайриорганикӣ', [
                  topic('chem-acids', 'Кислоты и основания', 'Кислотаҳо ва асосҳо'),
                  topic('chem-salts', 'Соли', 'Намакҳо'),
               ]),
            ],
         },
         {
            code: 'chem-reactions',
            ru: 'Химические реакции',
            tg: 'Реаксияҳои химиявӣ',
            topics: [
               topic('chem-reaction-types', 'Типы реакций', 'Навъҳои реаксияҳо'),
               topic('chem-rate', 'Скорость реакции', 'Суръати реаксия'),
               topic('chem-dissociation', 'Электролитическая диссоциация', 'Диссотсиатсияи электролитӣ'),
            ],
         },
         {
            code: 'chem-elements',
            ru: 'Металлы и неметаллы',
            tg: 'Металлҳо ва ғайриметаллҳо',
            topics: [
               topic('chem-metals', 'Металлы', 'Металлҳо'),
               topic('chem-halogens', 'Галогены', 'Галогенҳо'),
            ],
         },
      ],
   },
   {
      code: 'demo-physics',
      color: 'orange',
      titles: { ru: 'Физика', tg: 'Физика', en: 'Physics' },
      sections: [
         {
            code: 'phys-mechanics',
            ru: 'Механика',
            tg: 'Механика',
            topics: [
               topic('phys-motion', 'Равномерное движение', 'Ҳаракати яксон'),
               topic('phys-acceleration', 'Ускорение', 'Суръатбардорӣ'),
               topic('phys-newton', 'Законы Ньютона', 'Қонунҳои Нютон', [
                  topic('phys-force', 'Сила и масса', 'Қувва ва масса'),
               ]),
            ],
         },
         {
            code: 'phys-energy',
            ru: 'Энергия и работа',
            tg: 'Энергия ва кор',
            topics: [
               topic('phys-work', 'Работа и мощность', 'Кор ва иқтидор'),
               topic('phys-conservation', 'Закон сохранения энергии', 'Қонуни бақои энергия'),
               topic('phys-machines', 'Простые механизмы', 'Механизмҳои оддӣ'),
            ],
         },
         {
            code: 'phys-heat',
            ru: 'Тепловые явления',
            tg: 'Ҳодисаҳои гармӣ',
            topics: [
               topic('phys-temperature', 'Температура и теплопередача', 'Ҳарорат ва гармигузаронӣ'),
               topic('phys-states', 'Агрегатные состояния', 'Ҳолатҳои агрегатӣ'),
            ],
         },
      ],
   },
   {
      code: 'demo-math',
      color: 'purple',
      titles: { ru: 'Математика', tg: 'Математика', en: 'Mathematics' },
      sections: [
         {
            code: 'math-algebra',
            ru: 'Алгебра',
            tg: 'Алгебра',
            topics: [
               topic('math-linear', 'Линейные уравнения', 'Муодилаҳои хатӣ'),
               topic('math-quadratic', 'Квадратные уравнения', 'Муодилаҳои квадратӣ', [
                  topic('math-discriminant', 'Дискриминант', 'Дискриминант'),
               ]),
               topic('math-progressions', 'Прогрессии', 'Прогрессияҳо', [
                  topic('math-arithmetic', 'Арифметическая прогрессия', 'Прогрессияи арифметикӣ'),
                  topic('math-geometric', 'Геометрическая прогрессия', 'Прогрессияи геометрӣ'),
               ]),
            ],
         },
         {
            code: 'math-geometry',
            ru: 'Геометрия',
            tg: 'Геометрия',
            topics: [
               topic('math-triangles', 'Треугольники', 'Секунҷаҳо'),
               topic('math-circle', 'Окружность и круг', 'Давра ва доира'),
               topic('math-area', 'Площади фигур', 'Масоҳати шаклҳо'),
            ],
         },
         {
            code: 'math-practice',
            ru: 'Текстовые задачи',
            tg: 'Масъалаҳои матнӣ',
            topics: [
               topic('math-percent', 'Проценты', 'Фоизҳо'),
            ],
         },
      ],
   },
   {
      code: 'demo-russian',
      color: 'neutral',
      titles: { ru: 'Русский язык', tg: 'Забони русӣ', en: 'Russian language' },
      sections: [
         {
            code: 'rus-spelling',
            ru: 'Орфография',
            tg: 'Имло',
            topics: [
               topic('rus-roots', 'Правописание корней', 'Имлои реша'),
               topic('rus-prefixes', 'Приставки', 'Пешвандҳо'),
               topic('rus-endings', 'Окончания', 'Бандакҳо', [
                  topic('rus-verb-endings', 'Окончания глаголов', 'Бандакҳои феъл'),
               ]),
            ],
         },
         {
            code: 'rus-grammar',
            ru: 'Морфология и синтаксис',
            tg: 'Морфология ва синтаксис',
            topics: [
               topic('rus-parts-of-speech', 'Части речи', 'Қисмҳои калом'),
               topic('rus-cases', 'Падежи', 'Падежҳо'),
               topic('rus-punctuation', 'Знаки препинания', 'Аломатҳои китобат'),
            ],
         },
         {
            code: 'rus-speech',
            ru: 'Речь и стилистика',
            tg: 'Нутқ ва услубшиносӣ',
            topics: [
               topic('rus-lexicon', 'Лексика', 'Лексика'),
               topic('rus-text', 'Текст и стили речи', 'Матн ва услубҳои нутқ'),
            ],
         },
      ],
   },
]
