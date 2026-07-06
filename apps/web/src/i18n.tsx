import { createContext, useContext, useState, ReactNode } from 'react';

type Lang = 'az' | 'ru' | 'en';

const dict: Record<Lang, Record<string, string>> = {
  az: {
    login: 'Daxil ol', logout: 'Çıxış', email: 'E-poçt', password: 'Şifrə', register: 'Qeydiyyat',
    requests: 'Sifarişlər', events: 'Tenderlər', suppliers: 'Təchizatçılar', market: 'Açıq tenderlər',
    create: 'Yarat', submit: 'Göndər', approve: 'Təsdiqlə', reject: 'Rədd et', publish: 'Dərc et',
    invite: 'Dəvət et', bid: 'Təklif ver', withdraw: 'Geri götür', open_bids: 'Zərfləri aç',
    award: 'Qalib seç', title: 'Başlıq', status: 'Status', total: 'Məbləğ', deadline: 'Son tarix',
    items: 'Mövqelər', my_bid: 'Mənim təklifim', amounts_hidden: 'Məbləğlər açılışa qədər gizlidir',
    company: 'Şirkət', buyer_org: 'Sifarişçi', supplier_org: 'Təchizatçı', qty: 'Say',
    unit_price: 'Vahid qiymət', name: 'Ad', actions: 'Əməliyyatlar', directory: 'Kataloq',
    registry: 'Reyestr', score: 'Qiymətləndir', ocds: 'OCDS ixrac',
    dashboard: 'İdarə paneli', contracts: 'Müqavilələr', orders: 'Sifarişlər (PO)',
    my_orders: 'İşdə olan sifarişlər', spend: 'Ümumi xərc', savings: 'Qənaət',
    prev: 'Əvvəlki', next: 'Sonrakı', page: 'Səhifə',
    budgets: 'Büdcələr', committed: 'Öhdəlik', remaining: 'Qalıq', year: 'İl', amount: 'Məbləğ',
    utilization: 'İstifadə', budget_over: 'Büdcə aşılıb', save: 'Yadda saxla', category: 'Kateqoriya',
    analytics: 'Analitika', monthly_spend: 'Aylıq xərclər', by_category: 'Kateqoriyalar üzrə',
    top_suppliers: 'Əsas təchizatçılar', paid: 'Ödənilib', outstanding: 'Gözləyir',
    amendments: 'Dəyişikliklər', amend: 'Dəyişdir', reason: 'Səbəb', accept: 'Qəbul et',
    send: 'Göndər', proposal_text: 'Texniki təklif', response_text: 'Cavab (mətn)',
    guide: 'Video bələdçi', tour: 'Bölmə turu',
    active_events: 'Aktiv tenderlər', pending: 'Təsdiq gözləyir', tasks: 'Tapşırıqlar',
    notifications: 'Bildirişlər', activate: 'Aktivləşdir', create_po: 'PO yarat',
    make_contract: 'Müqavilə yarat', history: 'Tarixçə',
    auction: 'Auksion', best_price: 'Ən yaxşı qiymət', next_max: 'Növbəti maks.',
    bidders: 'İştirakçılar', extensions: 'Uzadılmalar', finalize: 'Yekunlaşdır',
    place_bid: 'Təklif ver', qna: 'Sual-cavab', ask: 'Soruş', answer: 'Cavabla',
    addendum: 'Əlavə', settings: 'Parametrlər', users: 'İstifadəçilər', scorecard: 'Reytinq', ai_reco: 'Süni intellekt tövsiyəsi', ai_run: 'Təhlil et', ai_model: 'Model', logistics: 'Logistika', create_shipment: 'Göndəriş yarat', direct_order: 'Birbaşa sifariş', attachments: 'Əlavələr', receive: 'Qəbul et', lots: 'Lotlar', approval_chain: 'Təsdiq zənciri', catalogs: 'Kataloqlar', quick_order: 'Sifariş', verification: 'Yoxlama', invoices: 'Qaimələr', invoice: 'Qaimə', pay: 'Ödə', my_bids: 'Mənim təkliflərim', forgot: 'Şifrəni unutdunuz?', reset_password: 'Şifrəni yenilə', reset_sent: 'Linki e-poçtunuza göndərdik.',
  },
  ru: {
    login: 'Войти', logout: 'Выход', email: 'Email', password: 'Пароль', register: 'Регистрация',
    requests: 'Заявки', events: 'Тендеры', suppliers: 'Поставщики', market: 'Открытые тендеры',
    create: 'Создать', submit: 'Отправить', approve: 'Утвердить', reject: 'Отклонить', publish: 'Опубликовать',
    invite: 'Пригласить', bid: 'Подать ставку', withdraw: 'Отозвать', open_bids: 'Вскрыть ставки',
    award: 'Выбрать победителя', title: 'Название', status: 'Статус', total: 'Сумма', deadline: 'Дедлайн',
    items: 'Позиции', my_bid: 'Моя ставка', amounts_hidden: 'Суммы скрыты до вскрытия',
    company: 'Компания', buyer_org: 'Заказчик', supplier_org: 'Поставщик', qty: 'Кол-во',
    unit_price: 'Цена за ед.', name: 'Наименование', actions: 'Действия', directory: 'Каталог',
    registry: 'Реестр', score: 'Оценить', ocds: 'OCDS экспорт',
    dashboard: 'Рабочий стол', contracts: 'Контракты', orders: 'Заказы (PO)',
    my_orders: 'Заказы в работе', spend: 'Объём закупок', savings: 'Экономия',
    prev: 'Назад', next: 'Вперёд', page: 'Стр.',
    budgets: 'Бюджеты', committed: 'Обязательства', remaining: 'Остаток', year: 'Год', amount: 'Сумма',
    utilization: 'Использование', budget_over: 'Превышен', save: 'Сохранить', category: 'Категория',
    analytics: 'Аналитика', monthly_spend: 'Расходы по месяцам', by_category: 'По категориям',
    top_suppliers: 'Топ поставщиков', paid: 'Оплачено', outstanding: 'К оплате',
    amendments: 'Изменения заказа', amend: 'Изменить', reason: 'Причина', accept: 'Принять',
    send: 'Отправить', proposal_text: 'Техническое предложение', response_text: 'Ответ (текст)',
    guide: 'Видео-гайд', tour: 'Тур по разделу',
    active_events: 'Активные тендеры', pending: 'Ждут утверждения', tasks: 'Задачи',
    notifications: 'Уведомления', activate: 'Активировать', create_po: 'Создать PO',
    make_contract: 'Создать контракт', history: 'История',
    auction: 'Аукцион', best_price: 'Лучшая цена', next_max: 'След. максимум',
    bidders: 'Участники', extensions: 'Продления', finalize: 'Завершить торги',
    place_bid: 'Сделать ставку', qna: 'Вопросы и ответы', ask: 'Спросить', answer: 'Ответить',
    addendum: 'Аддендум', settings: 'Настройки', users: 'Пользователи', scorecard: 'Рейтинг', ai_reco: 'ИИ-рекомендация', ai_run: 'Проанализировать', ai_model: 'Модель', logistics: 'Логистика', create_shipment: 'Оформить отгрузку', direct_order: 'Прямой заказ', attachments: 'Вложения', receive: 'Приёмка', lots: 'Лоты', approval_chain: 'Цепочка согласования', catalogs: 'Каталоги', quick_order: 'Заказать', verification: 'Верификация', invoices: 'Счета', invoice: 'Счёт', pay: 'Оплатить', my_bids: 'Мои ставки', forgot: 'Забыли пароль?', reset_password: 'Сбросить пароль', reset_sent: 'Ссылка отправлена на почту.',
  },
  en: {
    login: 'Log in', logout: 'Log out', email: 'Email', password: 'Password', register: 'Register',
    requests: 'Requests', events: 'Tenders', suppliers: 'Suppliers', market: 'Open tenders',
    create: 'Create', submit: 'Submit', approve: 'Approve', reject: 'Reject', publish: 'Publish',
    invite: 'Invite', bid: 'Place bid', withdraw: 'Withdraw', open_bids: 'Open bids',
    award: 'Award winner', title: 'Title', status: 'Status', total: 'Total', deadline: 'Deadline',
    items: 'Items', my_bid: 'My bid', amounts_hidden: 'Amounts sealed until opening',
    company: 'Company', buyer_org: 'Buyer', supplier_org: 'Supplier', qty: 'Qty',
    unit_price: 'Unit price', name: 'Name', actions: 'Actions', directory: 'Directory',
    registry: 'Registry', score: 'Score', ocds: 'OCDS export',
    dashboard: 'Dashboard', contracts: 'Contracts', orders: 'Orders (PO)',
    my_orders: 'Orders in progress', spend: 'Total spend', savings: 'Savings',
    prev: 'Prev', next: 'Next', page: 'Page',
    budgets: 'Budgets', committed: 'Committed', remaining: 'Remaining', year: 'Year', amount: 'Amount',
    utilization: 'Utilization', budget_over: 'Over budget', save: 'Save', category: 'Category',
    analytics: 'Analytics', monthly_spend: 'Monthly spend', by_category: 'By category',
    top_suppliers: 'Top suppliers', paid: 'Paid', outstanding: 'Outstanding',
    amendments: 'Order changes', amend: 'Amend', reason: 'Reason', accept: 'Accept',
    send: 'Send', proposal_text: 'Technical proposal', response_text: 'Response (text)',
    guide: 'Video guide', tour: 'Section tour',
    active_events: 'Active tenders', pending: 'Pending approval', tasks: 'Tasks',
    notifications: 'Notifications', activate: 'Activate', create_po: 'Create PO',
    make_contract: 'Create contract', history: 'History',
    auction: 'Auction', best_price: 'Best price', next_max: 'Next max',
    bidders: 'Bidders', extensions: 'Extensions', finalize: 'Finalize',
    place_bid: 'Place bid', qna: 'Q&A', ask: 'Ask', answer: 'Answer',
    addendum: 'Addendum', settings: 'Settings', users: 'Users', scorecard: 'Scorecard', ai_reco: 'AI recommendation', ai_run: 'Analyze', ai_model: 'Model', logistics: 'Logistics', create_shipment: 'Create shipment', direct_order: 'Direct order', attachments: 'Attachments', receive: 'Receive', lots: 'Lots', approval_chain: 'Approval chain', catalogs: 'Catalogs', quick_order: 'Quick order', verification: 'Verification', invoices: 'Invoices', invoice: 'Invoice', pay: 'Pay', my_bids: 'My bids', forgot: 'Forgot password?', reset_password: 'Reset password', reset_sent: 'Reset link sent to your email.',
  },
};

const I18nCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string }>({
  lang: 'ru', setLang: () => {}, t: (k) => k,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>((localStorage.getItem('lp_lang') as Lang) || 'ru');
  const setLang = (l: Lang) => { localStorage.setItem('lp_lang', l); setLangState(l); };
  const t = (k: string) => dict[lang][k] ?? k;
  return <I18nCtx.Provider value={{ lang, setLang, t }}>{children}</I18nCtx.Provider>;
}

export const useI18n = () => useContext(I18nCtx);
export const LANGS: Lang[] = ['az', 'ru', 'en'];
