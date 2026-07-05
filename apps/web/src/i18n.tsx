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
    active_events: 'Aktiv tenderlər', pending: 'Təsdiq gözləyir', tasks: 'Tapşırıqlar',
    notifications: 'Bildirişlər', activate: 'Aktivləşdir', create_po: 'PO yarat',
    make_contract: 'Müqavilə yarat', history: 'Tarixçə',
    auction: 'Auksion', best_price: 'Ən yaxşı qiymət', next_max: 'Növbəti maks.',
    bidders: 'İştirakçılar', extensions: 'Uzadılmalar', finalize: 'Yekunlaşdır',
    place_bid: 'Təklif ver', qna: 'Sual-cavab', ask: 'Soruş', answer: 'Cavabla',
    addendum: 'Əlavə', settings: 'Parametrlər', users: 'İstifadəçilər', scorecard: 'Reytinq', ai_reco: 'Süni intellekt tövsiyəsi', ai_run: 'Təhlil et', ai_model: 'Model', logistics: 'Logistika', create_shipment: 'Göndəriş yarat', direct_order: 'Birbaşa sifariş', forgot: 'Şifrəni unutdunuz?', reset_password: 'Şifrəni yenilə', reset_sent: 'Linki e-poçtunuza göndərdik.',
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
    active_events: 'Активные тендеры', pending: 'Ждут утверждения', tasks: 'Задачи',
    notifications: 'Уведомления', activate: 'Активировать', create_po: 'Создать PO',
    make_contract: 'Создать контракт', history: 'История',
    auction: 'Аукцион', best_price: 'Лучшая цена', next_max: 'След. максимум',
    bidders: 'Участники', extensions: 'Продления', finalize: 'Завершить торги',
    place_bid: 'Сделать ставку', qna: 'Вопросы и ответы', ask: 'Спросить', answer: 'Ответить',
    addendum: 'Аддендум', settings: 'Настройки', users: 'Пользователи', scorecard: 'Рейтинг', ai_reco: 'ИИ-рекомендация', ai_run: 'Проанализировать', ai_model: 'Модель', logistics: 'Логистика', create_shipment: 'Оформить отгрузку', direct_order: 'Прямой заказ', forgot: 'Забыли пароль?', reset_password: 'Сбросить пароль', reset_sent: 'Ссылка отправлена на почту.',
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
    active_events: 'Active tenders', pending: 'Pending approval', tasks: 'Tasks',
    notifications: 'Notifications', activate: 'Activate', create_po: 'Create PO',
    make_contract: 'Create contract', history: 'History',
    auction: 'Auction', best_price: 'Best price', next_max: 'Next max',
    bidders: 'Bidders', extensions: 'Extensions', finalize: 'Finalize',
    place_bid: 'Place bid', qna: 'Q&A', ask: 'Ask', answer: 'Answer',
    addendum: 'Addendum', settings: 'Settings', users: 'Users', scorecard: 'Scorecard', ai_reco: 'AI recommendation', ai_run: 'Analyze', ai_model: 'Model', logistics: 'Logistics', create_shipment: 'Create shipment', direct_order: 'Direct order', forgot: 'Forgot password?', reset_password: 'Reset password', reset_sent: 'Reset link sent to your email.',
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
