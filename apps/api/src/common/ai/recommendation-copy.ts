import type { Recommendation } from './ai-scorer';

// Structured numeric evidence is translated locally; supplier-provided names remain data.
export function recommendationCopy(rec: Recommendation, language = 'en'): Recommendation {
  if (language === 'en') return rec;
  const az=language==='az';
  const ranking=rec.ranking.map(r=>({...r,reasons:[
    `${az?'Qiymət balı':'Балл цены'}: ${r.priceScore}/100`,
    r.deliveryDays==null ? (az?'Çatdırılma müddəti göstərilməyib':'Срок доставки не указан') : `${az?'Çatdırılma':'Доставка'}: ${r.deliveryDays} ${az?'gün':'дн.'}`,
    `${az?'Etibarlılıq balı':'Балл надёжности'}: ${r.reliabilityScore}/100`,
    r.reasons.some(x=>/No scorecard|neutral/i.test(x)) ? (az?'Tarixçə yoxdur; neytral bal tətbiq edilir':'Истории оценок нет; применяется нейтральный балл') : (az?'Təchizatçı qiymətləndirmələrinin tarixçəsi':'История оценок поставщика'),
  ]}));
  const first=ranking[0];
  const rationale=first ? `${first.supplierName}: ${first.weightedTotal}/100. ${az?'Qiymət, çatdırılma və tarixçə üzrə köməkçi tövsiyədir; qalib ayrıca təsdiqlənir.':'Рекомендация по цене, доставке и истории; победитель утверждается отдельно.'}` : (az?'Qiymətləndiriləcək açılmış təklif yoxdur.':'Нет открытых предложений для оценки.');
  return {...rec,ranking,rationale};
}
