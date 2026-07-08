// Per-section guides: a screen-recording video + an interactive spotlight tour.
// Videos live in /public/guides (regenerate with `node scripts/produce-guides.mjs`).
// Tour texts are trilingual; the Spotlight picks the active UI language.

export type GuideLang = 'az' | 'ru' | 'en';
export type L10n = Record<GuideLang, string>;
export interface TourStep { selector: string; title: L10n; text: L10n }
export interface SectionGuide { key: string; tour?: TourStep[] }

// Videos are per-language: /guides/<key>.<lang>.webm (+ .png poster). The widget builds
// the URL from the active UI language; see components/Guide.tsx.
const g = (key: string, tour?: TourStep[]): SectionGuide => ({ key, tour });

export const GUIDES: Record<string, SectionGuide> = {
  '/buyer/dashboard': g('buyer-dashboard', [
    {
      selector: 'h1',
      title: { ru: 'Рабочий стол', az: 'İdarə paneli', en: 'Dashboard' },
      text: {
        ru: 'Сводка закупщика: деньги, тендеры и то, что требует вашего решения.',
        az: 'Satınalmaçının icmalı: pul, tenderlər və qərarınızı gözləyən işlər.',
        en: 'The buyer’s overview: money, tenders and whatever needs your decision.',
      },
    },
    {
      selector: '.card',
      title: { ru: 'KPI', az: 'KPI', en: 'KPIs' },
      text: {
        ru: 'Объём закупок, экономия на тендерах, активные события и заказы — считаются из реальных данных.',
        az: 'Satınalma həcmi, tenderlərdə qənaət, aktiv tenderlər və sifarişlər — real məlumatlardan hesablanır.',
        en: 'Procurement volume, tender savings, active events and orders — computed from live data.',
      },
    },
    {
      selector: 'table',
      title: { ru: 'Задачи', az: 'Tapşırıqlar', en: 'Tasks' },
      text: {
        ru: 'Что сделать прямо сейчас: утвердить заявку, вскрыть ставки, наградить, принять поставку. Стрелка ведёт в нужный раздел.',
        az: 'İndi görüləcək işlər: sifarişi təsdiqlə, zərfləri aç, qalibi seç, çatdırılmanı qəbul et. Ox lazımi bölməyə aparır.',
        en: 'What to do right now: approve a request, open bids, award, accept a delivery. The arrow jumps to the right section.',
      },
    },
  ]),
  '/buyer/requests': g('buyer-requests', [
    {
      selector: 'form',
      title: { ru: 'Новая заявка', az: 'Yeni sifariş', en: 'New request' },
      text: {
        ru: 'Внутренняя потребность: название, категория и позиции с количеством и оценкой цены. Суммы сервер пересчитывает сам.',
        az: 'Daxili tələbat: başlıq, kateqoriya və say + qiymət smetası ilə mövqelər. Məbləğləri server özü hesablayır.',
        en: 'An internal need: title, category and line items with quantity and price estimate. The server recomputes totals itself.',
      },
    },
    {
      selector: 'table',
      title: { ru: 'Реестр заявок', az: 'Sifariş reyestri', en: 'Request register' },
      text: {
        ru: 'DRAFT — черновик, SUBMITTED — ждёт утверждения, APPROVED — можно запускать закупку.',
        az: 'DRAFT — qaralama, SUBMITTED — təsdiq gözləyir, APPROVED — satınalmanı başlatmaq olar.',
        en: 'DRAFT is editable, SUBMITTED awaits approval, APPROVED is ready for sourcing.',
      },
    },
    {
      selector: 'tbody .btn',
      title: { ru: 'Действия', az: 'Əməliyyatlar', en: 'Actions' },
      text: {
        ru: 'У утверждённой заявки: RFQ 🔒 (запечатанный тендер), RFP 📄 (с техпредложением), RFI ❓ (сбор информации), Аукцион ⚡. Мелкие суммы политика отправляет в прямой заказ.',
        az: 'Təsdiqlənmiş sifarişdə: RFQ 🔒 (möhürlü tender), RFP 📄 (texniki təkliflə), RFI ❓ (məlumat toplama), Auksion ⚡. Kiçik məbləğləri siyasət birbaşa sifarişə göndərir.',
        en: 'For an approved request: RFQ 🔒 (sealed tender), RFP 📄 (with technical proposal), RFI ❓ (information gathering), Auction ⚡. Small amounts go to a direct order per policy.',
      },
    },
  ]),
  '/buyer/events': g('buyer-events', [
    {
      selector: 'table',
      title: { ru: 'Тендеры', az: 'Tenderlər', en: 'Tenders' },
      text: {
        ru: 'Все процедуры: OPEN — идёт приём ставок, AWARDED — победитель выбран. Колонка «Предложения» — сколько ставок подано (суммы до вскрытия скрыты).',
        az: 'Bütün prosedurlar: OPEN — təkliflər qəbul olunur, AWARDED — qalib seçilib. «Təkliflər» sütunu — neçə təklif verilib (məbləğlər açılışa qədər gizlidir).',
        en: 'All procedures: OPEN is accepting bids, AWARDED has a winner. The bids column counts submissions (amounts stay sealed until opening).',
      },
    },
  ]),
  '/buyer/events/': g('buyer-events', [
    {
      selector: 'h1',
      title: { ru: 'Карточка тендера', az: 'Tender kartı', en: 'Tender detail' },
      text: {
        ru: 'Тип (RFQ/RFP/RFI) и статус. Дедлайн контролирует сервер — после него ставки не принимаются.',
        az: 'Tip (RFQ/RFP/RFI) və status. Son tarixi server nəzarət edir — ondan sonra təkliflər qəbul edilmir.',
        en: 'Type (RFQ/RFP/RFI) and status. The server enforces the deadline — no bids after it.',
      },
    },
    {
      selector: 'h3',
      title: { ru: 'Позиции и лоты', az: 'Mövqelər və lotlar', en: 'Items and lots' },
      text: {
        ru: 'Снимок позиций из заявки. Лоты можно награждать разным поставщикам.',
        az: 'Sifarişdən götürülmüş mövqelərin snapshotu. Lotları müxtəlif təchizatçılara vermək olar.',
        en: 'A snapshot of the request’s items. Lots can be awarded to different suppliers.',
      },
    },
    {
      selector: 'table',
      title: { ru: 'Ставки', az: 'Təkliflər', en: 'Bids' },
      text: {
        ru: 'До вскрытия — только факт участия 🔒. После: суммы, сроки, оценка и кнопки награждения.',
        az: 'Açılışa qədər yalnız iştirak faktı 🔒. Sonra: məbləğlər, müddətlər, qiymətləndirmə və qalib seçimi.',
        en: 'Before opening — participation only 🔒. After: amounts, delivery, scoring and award buttons.',
      },
    },
  ]),
  '/buyer/contracts': g('buyer-contracts', [
    {
      selector: 'table',
      title: { ru: 'Контракты', az: 'Müqavilələr', en: 'Contracts' },
      text: {
        ru: 'Создаются из награждённого тендера. ACTIVE контракт умеет выпускать заказы и каталоги. Колонка «Выбрано» следит за потолком контракта.',
        az: 'Qalib seçilmiş tenderdən yaranır. ACTIVE müqavilə sifarişlər və kataloqlar burax bilir. «İstifadə olunub» sütunu müqavilə limitini izləyir.',
        en: 'Created from an awarded tender. An ACTIVE contract issues orders and catalogs. The drawn column tracks the contract ceiling.',
      },
    },
    {
      selector: '.card:nth-of-type(2) table',
      title: { ru: 'Заказы (PO)', az: 'Sifarişlər (PO)', en: 'Purchase orders' },
      text: {
        ru: 'Жизненный цикл: ISSUED → CONFIRMED → PACKED → SHIPPED → DELIVERED → ACCEPTED. Кнопка ✎ — изменение заказа (кол-во/цена) с согласием поставщика.',
        az: 'Həyat dövrü: ISSUED → CONFIRMED → PACKED → SHIPPED → DELIVERED → ACCEPTED. ✎ düyməsi — təchizatçının razılığı ilə sifariş dəyişikliyi (say/qiymət).',
        en: 'Lifecycle: ISSUED → CONFIRMED → PACKED → SHIPPED → DELIVERED → ACCEPTED. The ✎ button proposes a change order (qty/price) the supplier must accept.',
      },
    },
  ]),
  '/buyer/invoices': g('buyer-invoices', [
    {
      selector: 'table',
      title: { ru: 'Счета', az: 'Qaimələr', en: 'Invoices' },
      text: {
        ru: 'Поставщик выставляет счёт по заказу. Система сверяет: заказ ↔ приёмка ↔ счёт (3-way match) → MATCHED или DISPUTED. Дальше утверждение и оплата.',
        az: 'Təchizatçı sifariş üzrə qaimə göndərir. Sistem üzləşdirir: sifariş ↔ qəbul ↔ qaimə (3 tərəfli) → MATCHED və ya DISPUTED. Sonra təsdiq və ödəniş.',
        en: 'The supplier invoices an order. The system runs a 3-way match: order ↔ receipt ↔ invoice → MATCHED or DISPUTED. Then approval and payment.',
      },
    },
  ]),
  '/buyer/catalogs': g('buyer-catalogs', [
    {
      selector: '.card',
      title: { ru: 'Каталоги', az: 'Kataloqlar', en: 'Catalogs' },
      text: {
        ru: 'Согласованные прайс-листы поставщика. Заказ по каталожной цене создаётся мгновенно — без нового тендера. MOQ контролируется.',
        az: 'Təchizatçının razılaşdırılmış qiymət cədvəlləri. Kataloq qiyməti ilə sifariş dərhal yaranır — yeni tender lazım deyil. MOQ nəzarətdədir.',
        en: 'Agreed supplier price lists. A catalog-price order is created instantly — no new tender. MOQ is enforced.',
      },
    },
  ]),
  '/buyer/budgets': g('buyer-budgets', [
    {
      selector: 'form',
      title: { ru: 'Бюджет', az: 'Büdcə', en: 'Budget' },
      text: {
        ru: 'Лимит на категорию и год. «*» — на все категории.',
        az: 'Kateqoriya və il üzrə limit. «*» — bütün kateqoriyalara.',
        en: 'A limit per category and year. “*” covers all categories.',
      },
    },
    {
      selector: '.budget-bar',
      title: { ru: 'Использование', az: 'İstifadə', en: 'Utilization' },
      text: {
        ru: 'Утверждённые заявки «съедают» бюджет. Красная полоса — превышение: утверждение не блокируется, но предупреждает.',
        az: 'Təsdiqlənmiş sifarişlər büdcəni «yeyir». Qırmızı zolaq — aşım: təsdiq bloklanmır, amma xəbərdarlıq edir.',
        en: 'Approved requests draw the budget down. A red bar means overrun: approval is not blocked, but it warns.',
      },
    },
  ]),
  '/buyer/analytics': g('buyer-analytics', [
    {
      selector: '.chart',
      title: { ru: 'Расходы по месяцам', az: 'Aylıq xərclər', en: 'Monthly spend' },
      text: {
        ru: 'Расход = принятые заказы (ACCEPTED). Пустые месяцы — нули, не пропуски.',
        az: 'Xərc = qəbul edilmiş sifarişlər (ACCEPTED). Boş aylar sıfırdır, buraxılmayıb.',
        en: 'Spend = ACCEPTED purchase orders. Empty months are zeros, not gaps.',
      },
    },
    {
      selector: '.card:nth-of-type(3)',
      title: { ru: 'Категории и поставщики', az: 'Kateqoriyalar və təchizatçılar', en: 'Categories and suppliers' },
      text: {
        ru: 'Куда уходят деньги и кто главные поставщики. Экономия = оценка заявки минус выигравшая ставка.',
        az: 'Pul hara gedir və əsas təchizatçılar kimdir. Qənaət = sifarişin smetası minus qalib təklif.',
        en: 'Where the money goes and who the top suppliers are. Savings = request estimate minus the winning bid.',
      },
    },
  ]),
  '/buyer/logistics': g('buyer-logistics', [
    {
      selector: 'table',
      title: { ru: 'Логистика', az: 'Logistika', en: 'Logistics' },
      text: {
        ru: 'Отгрузки по заказам: перевозчик, трек-номер, события в пути. Статусы двигает поставщик.',
        az: 'Sifarişlər üzrə göndərişlər: daşıyıcı, izləmə nömrəsi, yol hadisələri. Statusları təchizatçı irəli aparır.',
        en: 'Shipments per order: carrier, tracking number, transit events. The supplier advances the statuses.',
      },
    },
  ]),
  '/buyer/suppliers': g('buyer-suppliers', [
    {
      selector: 'table',
      title: { ru: 'Реестр поставщиков', az: 'Təchizatçı reyestri', en: 'Supplier registry' },
      text: {
        ru: 'INVITED → APPROVED/BLOCKED. Только одобренные получают прямые заказы и каталоги. Рейтинг: OTIF, качество, коммуникации.',
        az: 'INVITED → APPROVED/BLOCKED. Yalnız təsdiqlənmişlər birbaşa sifariş və kataloq alır. Reytinq: OTIF, keyfiyyət, kommunikasiya.',
        en: 'INVITED → APPROVED/BLOCKED. Only approved suppliers get direct orders and catalogs. Scorecard: OTIF, quality, communication.',
      },
    },
  ]),
  '/buyer/verification': g('buyer-verification', [
    {
      selector: 'table',
      title: { ru: 'Верификация (KYC)', az: 'Yoxlama (KYC)', en: 'Verification (KYC)' },
      text: {
        ru: 'Кейс проверки поставщика: он загружает документы (VÖEN, лицензии), вы решаете. APPROVED автоматически открывает поставщику прямые заказы.',
        az: 'Təchizatçının yoxlama işi: o, sənədləri yükləyir (VÖEN, lisenziyalar), siz qərar verirsiniz. APPROVED birbaşa sifarişləri avtomatik açır.',
        en: 'A supplier verification case: they upload documents (VÖEN, licenses), you decide. APPROVED automatically unlocks direct orders.',
      },
    },
  ]),
  '/supplier/dashboard': g('sup-dashboard', [
    {
      selector: 'h1',
      title: { ru: 'Рабочий стол поставщика', az: 'Təchizatçı paneli', en: 'Supplier dashboard' },
      text: {
        ru: 'Открытые тендеры, мои ставки, заказы в работе и счета.',
        az: 'Açıq tenderlər, mənim təkliflərim, işdə olan sifarişlər və qaimələr.',
        en: 'Open tenders, my bids, orders in progress and invoices.',
      },
    },
    {
      selector: 'table',
      title: { ru: 'Задачи', az: 'Tapşırıqlar', en: 'Tasks' },
      text: {
        ru: 'Подать ставку, продвинуть доставку, выставить счёт — всё, что ждёт действий.',
        az: 'Təklif ver, çatdırılmanı irəli apar, qaimə göndər — hərəkət gözləyən hər şey.',
        en: 'Submit a bid, advance a delivery, send an invoice — everything awaiting action.',
      },
    },
  ]),
  '/supplier/market': g('sup-market', [
    {
      selector: 'table',
      title: { ru: 'Открытые тендеры', az: 'Açıq tenderlər', en: 'Open tenders' },
      text: {
        ru: 'Тендеры, куда вас пригласили (или публичные). Зайдите внутрь, чтобы подать ставку.',
        az: 'Dəvət olunduğunuz (və ya açıq) tenderlər. Təklif vermək üçün daxil olun.',
        en: 'Tenders you were invited to (or public ones). Open one to submit a bid.',
      },
    },
  ]),
  '/supplier/events/': g('sup-market', [
    {
      selector: 'table',
      title: { ru: 'Позиции', az: 'Mövqelər', en: 'Line items' },
      text: {
        ru: 'Введите цену за единицу по каждой позиции. Итог считается сам.',
        az: 'Hər mövqe üzrə vahid qiyməti daxil edin. Yekun özü hesablanır.',
        en: 'Enter a unit price for every line. The total computes itself.',
      },
    },
    {
      selector: 'button.btn:not(.ghost)',
      title: { ru: 'Запечатанная ставка 🔒', az: 'Möhürlü təklif 🔒', en: 'Sealed bid 🔒' },
      text: {
        ru: 'Ставка шифруется: закупщик не видит сумм до вскрытия. До дедлайна можно отозвать и подать заново.',
        az: 'Təklif şifrələnir: sifarişçi məbləğləri açılışa qədər görmür. Son tarixə qədər geri götürüb yenidən vermək olar.',
        en: 'The bid is encrypted: the buyer sees no amounts until opening. Before the deadline you can withdraw and resubmit.',
      },
    },
  ]),
  '/supplier/orders': g('sup-orders', [
    {
      selector: 'table',
      title: { ru: 'Конвейер поставки', az: 'Çatdırılma konveyeri', en: 'Fulfilment pipeline' },
      text: {
        ru: 'Двигайте заказ: CONFIRMED → PACKED → SHIPPED → DELIVERED. Создайте отгрузку с трек-номером (🚚).',
        az: 'Sifarişi irəli aparın: CONFIRMED → PACKED → SHIPPED → DELIVERED. İzləmə nömrəsi ilə göndəriş yaradın (🚚).',
        en: 'Advance the order: CONFIRMED → PACKED → SHIPPED → DELIVERED. Create a shipment with a tracking number (🚚).',
      },
    },
    {
      selector: 'tbody .btn',
      title: { ru: 'Изменения и счета', az: 'Dəyişikliklər və qaimələr', en: 'Changes and invoices' },
      text: {
        ru: '✎ — поправки закупщика (примите или отклоните — суммы пересчитаются). 🧾 — выставить счёт после доставки.',
        az: '✎ — sifarişçinin dəyişiklikləri (qəbul edin və ya rədd edin — məbləğlər yenidən hesablanır). 🧾 — çatdırılmadan sonra qaimə göndərin.',
        en: '✎ — buyer change orders (accept or reject, totals recompute). 🧾 — invoice after delivery.',
      },
    },
  ]),
  '/supplier/invoices': g('sup-invoices', [
    {
      selector: 'table',
      title: { ru: 'Мои счета', az: 'Qaimələrim', en: 'My invoices' },
      text: {
        ru: 'Счета по вашим заказам и их статусы. MATCHED — сверка прошла, счёт утвердят и оплатят; DISPUTED — расхождение. Кнопка UBL выгружает счёт в международном формате.',
        az: 'Sifarişləriniz üzrə qaimələr və statuslar. MATCHED — yoxlama keçdi, qaimə təsdiqlənib ödəniləcək; DISPUTED — uyğunsuzluq. UBL düyməsi qaiməni beynəlxalq formatda ixrac edir.',
        en: 'Invoices for your orders and their statuses. MATCHED — reconciled, will be approved and paid; DISPUTED — a discrepancy. The UBL button exports the invoice in an international format.',
      },
    },
  ]),
  '/supplier/verification': g('sup-verification', [
    {
      selector: 'table, .card',
      title: { ru: 'Верификация (KYC)', az: 'Yoxlama (KYC)', en: 'Verification (KYC)' },
      text: {
        ru: 'Загрузите запрошенные документы (VÖEN, лицензии). После одобрения закупщик открывает вам прямые заказы и каталоги без отдельного тендера.',
        az: 'Tələb olunan sənədləri yükləyin (VÖEN, lisenziyalar). Təsdiqdən sonra alıcı sizə ayrıca tender olmadan birbaşa sifarişləri və kataloqları açır.',
        en: 'Upload the requested documents (VÖEN, licenses). After approval the buyer unlocks direct orders and catalogs for you without a separate tender.',
      },
    },
  ]),
};
