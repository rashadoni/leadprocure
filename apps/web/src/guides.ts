// Per-section guides: a screen-recording video + an interactive spotlight tour.
// Videos live in /public/guides (regenerate with `node scripts/record-guides.mjs`).
// Tour texts are RU for the demo audience (MVP; move into i18n when needed).

export interface TourStep { selector: string; title: string; text: string }
export interface SectionGuide { key: string; tour?: TourStep[] }

// Videos are per-language: /guides/<key>.<lang>.webm (+ .png poster). The widget builds
// the URL from the active UI language; see components/Guide.tsx.
const g = (key: string, tour?: TourStep[]): SectionGuide => ({ key, tour });

export const GUIDES: Record<string, SectionGuide> = {
  '/buyer/dashboard': g('buyer-dashboard', [
    { selector: 'h1', title: 'Рабочий стол', text: 'Сводка закупщика: деньги, тендеры и то, что требует вашего решения.' },
    { selector: '.card', title: 'KPI', text: 'Объём закупок, экономия на тендерах, активные события и заказы — считаются из реальных данных.' },
    { selector: 'table', title: 'Задачи', text: 'Что сделать прямо сейчас: утвердить заявку, вскрыть ставки, наградить, принять поставку. Стрелка ведёт в нужный раздел.' },
  ]),
  '/buyer/requests': g('buyer-requests', [
    { selector: 'form', title: 'Новая заявка', text: 'Внутренняя потребность: название и позиции с количеством и оценкой цены. Суммы сервер пересчитывает сам.' },
    { selector: 'table', title: 'Реестр заявок', text: 'DRAFT — черновик, SUBMITTED — ждёт утверждения, APPROVED — можно запускать закупку.' },
    { selector: 'tbody .btn', title: 'Действия', text: 'У утверждённой заявки: RFQ 🔒 (запечатанный тендер), RFP 📄 (с техпредложением), RFI ❓ (сбор информации), Аукцион ⚡. Мелкие суммы политика отправляет в прямой заказ.' },
  ]),
  '/buyer/events': g('buyer-events', [
    { selector: 'table', title: 'Тендеры', text: 'Все процедуры: OPEN — идёт приём ставок, AWARDED — победитель выбран. Колонка Bids — сколько ставок подано (суммы до вскрытия скрыты).' },
  ]),
  '/buyer/events/': g('buyer-events', [
    { selector: 'h1', title: 'Карточка тендера', text: 'Тип (RFQ/RFP/RFI) и статус. Дедлайн контролирует сервер — после него ставки не принимаются.' },
    { selector: 'h3', title: 'Позиции и лоты', text: 'Снимок позиций из заявки. Лоты можно награждать разным поставщикам.' },
    { selector: 'table', title: 'Ставки', text: 'До вскрытия — только факт участия 🔒. После: суммы, сроки, оценка и кнопки награждения.' },
  ]),
  '/buyer/contracts': g('buyer-contracts', [
    { selector: 'table', title: 'Контракты', text: 'Создаются из награждённого тендера. ACTIVE контракт умеет выпускать заказы и каталоги.' },
    { selector: '.card:nth-of-type(2) table', title: 'Заказы (PO)', text: 'Жизненный цикл: ISSUED → CONFIRMED → PACKED → SHIPPED → DELIVERED → ACCEPTED. Кнопка ✎ — изменение заказа (кол-во/цена) с согласием поставщика.' },
  ]),
  '/buyer/invoices': g('buyer-invoices', [
    { selector: 'table', title: 'Счета', text: 'Поставщик выставляет счёт по заказу. Система сверяет: заказ ↔ приёмка ↔ счёт (3-way match) → MATCHED или DISPUTED. Дальше утверждение и оплата.' },
  ]),
  '/buyer/catalogs': g('buyer-catalogs', [
    { selector: '.card', title: 'Каталоги', text: 'Согласованные прайс-листы поставщика. Заказ по каталожной цене создаётся мгновенно — без нового тендера. MOQ контролируется.' },
  ]),
  '/buyer/budgets': g('buyer-budgets', [
    { selector: 'form', title: 'Бюджет', text: 'Лимит на категорию и год. «*» — на все категории.' },
    { selector: '.budget-bar', title: 'Использование', text: 'Утверждённые заявки «съедают» бюджет. Красная полоса — превышение: утверждение не блокируется, но предупреждает.' },
  ]),
  '/buyer/analytics': g('buyer-analytics', [
    { selector: '.chart', title: 'Расходы по месяцам', text: 'Расход = принятые заказы (ACCEPTED). Пустые месяцы — нули, не пропуски.' },
    { selector: '.card:nth-of-type(3)', title: 'Категории и поставщики', text: 'Куда уходят деньги и кто главные поставщики. Экономия = оценка заявки минус выигравшая ставка.' },
  ]),
  '/buyer/logistics': g('buyer-logistics', [
    { selector: 'table', title: 'Логистика', text: 'Отгрузки по заказам: перевозчик, трек-номер, события в пути. Статусы двигает поставщик.' },
  ]),
  '/buyer/suppliers': g('buyer-suppliers', [
    { selector: 'table', title: 'Реестр поставщиков', text: 'INVITED → APPROVED/BLOCKED. Только одобренные получают прямые заказы и каталоги. Рейтинг: OTIF, качество, коммуникации.' },
  ]),
  '/buyer/verification': g('buyer-verification', [
    { selector: 'table', title: 'Верификация (KYC)', text: 'Кейс проверки поставщика: он загружает документы (VÖEN, лицензии), вы решаете. APPROVED автоматически открывает поставщику прямые заказы.' },
  ]),
  '/supplier/dashboard': g('sup-dashboard', [
    { selector: 'h1', title: 'Рабочий стол поставщика', text: 'Открытые тендеры, мои ставки, заказы в работе и счета.' },
    { selector: 'table', title: 'Задачи', text: 'Подать ставку, продвинуть доставку, выставить счёт — всё, что ждёт действий.' },
  ]),
  '/supplier/market': g('sup-market', [
    { selector: 'table', title: 'Открытые тендеры', text: 'Тендеры, куда вас пригласили (или публичные). Зайдите внутрь, чтобы подать ставку.' },
  ]),
  '/supplier/events/': g('sup-market', [
    { selector: 'table', title: 'Позиции', text: 'Введите цену за единицу по каждой позиции. Итог считается сам.' },
    { selector: 'button.btn:not(.ghost)', title: 'Запечатанная ставка 🔒', text: 'Ставка шифруется: закупщик не видит сумм до вскрытия. До дедлайна можно отозвать и подать заново.' },
  ]),
  '/supplier/orders': g('sup-orders', [
    { selector: 'table', title: 'Конвейер поставки', text: 'Двигайте заказ: CONFIRMED → PACKED → SHIPPED → DELIVERED. Создайте отгрузку с трек-номером (🚚).' },
    { selector: 'tbody .btn', title: 'Изменения и счета', text: '✎ — поправки закупщика (примите или отклоните — суммы пересчитаются). 🧾 — выставить счёт после доставки.' },
  ]),
};
