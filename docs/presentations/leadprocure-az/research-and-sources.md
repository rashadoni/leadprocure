# Leadprocure — müştəri təqdimatı üçün araşdırma və mənbələr

Tarix: 26 oktyabr 2026. Auditoriya: potensial müştərilər. Təqdimat dili: Azərbaycan dili.

Bu qeyd təqdimatın redaktə və fakt yoxlaması üçün hazırlanıb. Mənbə cari repozitoriyanın kodu, Azərbaycan dilində interfeys görüntüləri və video-bələdçi ssenariləridir. Production mühiti, xarici xidmətlərin qoşulması və real müştəri nəticələri bu araşdırmada yoxlanılmayıb. Məxfi məlumat və giriş rekvizitləri daxil edilməyib.

## Redaktə yanaşması

- Əsas fikir: **“Satınalma tələbindən ödənişin uçotuna qədər vahid iş prosesi.”** “Ödənişin uçotu” bank köçürməsi ilə qarışdırılmamalıdır.
- Hər slayd bir müştəri sualına cavab versin: nə baş verir, kim qərar verir, hansı məlumat görünür və növbəti addım nədir.
- Daxili ehtiyac üçün **satınalma tələbi**, təchizatçıya verilən PO üçün **satınalma sifarişi**, kommersiya təklifi üçün **təklif**, invoice üçün interfeysə uyğun **qaimə** işlədilsin.
- RFQ — qiymət təklifi sorğusu; RFP — texniki və kommersiya təklifi sorğusu; RFI — məlumat sorğusu; revers-auksion — qiymətin aşağı salındığı auksion. Qısaltma ilk istifadədə açıqlansın.
- Faydanı mexanizmlə əlaqələndirin: “Yazışmaların yerinə bütün qərarlar və statuslar bir prosesdə görünür”; “Açılışa qədər qiymətlər alıcıdan gizli saxlanılır”; “Uyğunsuzluq qaimənin təsdiqindən əvvəl görünür”.
- Faktiki interfeysdə olan məlumatları saxlamaq olar; demonstrasiya şirkətlərini müştəri və ya kommersiya referansı kimi göstərməyin.
- Sübut edilməmiş qənaət faizi, məhsuldarlıq artımı, SLA, istifadəçi sayı, sertifikat, qiymət və tətbiq müddəti yazılmasın.
- Mövcud kod tarixi sənədin təsvirindən üstündür. Məsələn, AI xidməti və kanal inteqrasiyaları bəzi köhnə AGENTS.md qeydlərindən daha irəlidədir.

## Vahid nümayiş nümunəsi və hesablamalar

Ssenari: **“Data mərkəzi üçün server avadanlığı”**. Mənbə: `scripts/demo-fill.mjs:197–246`; Azərbaycan dilində adlar: `scripts/demo-fill.mjs:45`.

| Mövqe | Miqdar | Smeta, vahid qiyməti | Supply One, vahid qiyməti | Baku Metal, vahid qiyməti |
|---|---:|---:|---:|---:|
| Server 2U, 64 GB RAM | 4 | 12 000 AZN | 10 800 AZN | 11 500 AZN |
| Kommutator, 48 port | 2 | 4 500 AZN | 4 150 AZN | 4 300 AZN |
| ƏDV-siz cəmi | | **57 000 AZN** | **51 500 AZN** | **54 600 AZN** |
| Çatdırılma müddəti | | — | 21 gün | 14 gün |

Hesablamalar:

- Smeta: `4 × 12 000 + 2 × 4 500 = 57 000 AZN`.
- Seçilən Supply One təklifi: `4 × 10 800 + 2 × 4 150 = 51 500 AZN`.
- Smetaya nisbətən fərq: `57 000 − 51 500 = 5 500 AZN`.
- Fərq faizi: `5 500 / 57 000 × 100 = 9,6491…%`, yuvarlaq **9,65%**.
- Bu nümunədə 18% ƏDV: `51 500 × 0,18 = 9 270 AZN`.
- ƏDV daxil qaimə: `51 500 + 9 270 = 60 770 AZN`.

Ssenaridə Supply One qiymətləndirmədən sonra seçilir; müqavilə, PO, Bakı–Sumqayıt göndərişi, qəbul və PAID statuslu qaimə yaradılır. İki təklifi yalnız ən ucuz qiymət meyarı ilə müqayisə etməyin: ikinci təchizatçının çatdırılma müddəti daha qısadır. Formal qiymətləndirmə və AI tövsiyəsi ayrı anlayışlardır.

Slaydda görünən qeyd: **“Nümayiş nümunəsi. Smeta və təkliflər ƏDV-sizdir. Qaimə 18% ƏDV ilə göstərilib. Bu rəqəmlər real müştərinin nəticəsi deyil.”**

ƏDV hüquqi məsləhət kimi təqdim edilməməlidir. Kod ƏDV-ni PO mövqeyinin dərəcəsinə əsasən hesablayır; bütün qaimələrə məcburi 18% tətbiq etmir: `apps/api/src/modules/invoices/invoices.module.ts:76–83`.

## Faktlar və mənbə xəritəsi

Yollar repozitoriyanın kökünə nisbidir. Sətirlər bu təqdimatın hazırlandığı checkout-a aiddir.

| Təqdimatda istifadə olunan fakt | Kod və ssenari mənbəsi |
|---|---|
| Alıcı və təchizatçı üçün ayrı iş sahələri, rol əsasında giriş | `apps/web/src/main.tsx:46–78` |
| Alıcı panelində KPI və əməliyyat tələb edən tapşırıqlar | `apps/api/src/modules/dashboard/dashboard.module.ts:15–47`; `apps/web/src/guides.ts:15–43` |
| Tələbin məbləği serverdə hesablanır, metod siyasət üzrə müəyyən edilir | `apps/api/src/modules/requests/requests.module.ts:170–227` |
| Müəllif öz tələbini təsdiqləyə bilmir; təsdiq addımları fərqli şəxslərdən tələb olunur | `apps/api/src/modules/requests/requests.module.ts:177–201` |
| RFQ/RFP/RFI; RFP-də texniki təklif, RFI-də qiymətsiz cavab | `apps/api/src/modules/sourcing/sourcing.service.ts:72–107,349–355` |
| Qiymətləndirmə meyarları tender yaradılarkən müəyyən edilir | `apps/api/src/modules/sourcing/sourcing.service.ts:94–107,485–519` |
| Təklif məbləğləri AES-256-GCM ilə şifrələnir | `apps/api/src/common/crypto/sealed.service.ts:5–7,23–33` |
| Təklifin son tarixi server tərəfindən yoxlanılır | `apps/api/src/modules/sourcing/sourcing.service.ts:327–345` |
| Formal qiymətləndirmə, lot üzrə seçim; bir təklif və ya birinci olmayan iştirakçı seçiləndə əsaslandırma | `apps/api/src/modules/sourcing/sourcing.service.ts:533–618` |
| Auksionda cari ən yaxşı qiymət və növbəti mümkün hədd | `apps/api/src/modules/sourcing/auction.service.ts:98–111,164–166` |
| Auksionda son anda verilən təklif üçün məhdud müddət uzadılması | `apps/api/src/modules/sourcing/auction.service.ts:198–205` |
| Təchizatçı cavabından sonra xatırlatma zəncirinin dayanması | `apps/api/src/modules/sourcing/sourcing.service.ts:413–415`; `apps/api/src/modules/sourcing/auction.service.ts:195–196` |
| Plan üzrə e-poçt/WhatsApp xatırlatmaları və göndəriş nəticələri | `apps/api/src/modules/followups/followups.module.ts:186–249` |
| Müqavilə, PO statusları və təchizatçı razılığı ilə dəyişiklik | `apps/web/src/guides.ts:110–129`; `scripts/produce-guides.mjs:377–388` |
| Sifariş, qəbul və qaimənin üçtərəfli üzləşdirilməsi; artıq qaimələnmiş miqdarın nəzərə alınması | `apps/api/src/modules/invoices/invoices.module.ts:32–84` |
| Qaimə statusunun dəyişməsi auditə və bildirişə yazılır | `apps/api/src/modules/invoices/invoices.module.ts:214–220` |
| Kataloqda razılaşdırılmış qiymətlə sifariş və minimum miqdar | `apps/web/src/guides.ts:143–153`; `scripts/produce-guides.mjs:403–410` |
| Büdcə istifadəsi təsdiqlənmiş tələblər üzrə hesablanır | `apps/api/src/modules/budgets/budgets.module.ts:30–63` |
| Büdcə aşımında xəbərdarlıq, təsdiqi bloklamayan davranış | `apps/api/src/modules/budgets/budgets.module.ts:114–137` |
| Xərc analitikası qəbul edilmiş PO-lara əsaslanır; aylar, kateqoriyalar, təchizatçılar və qaimələr | `apps/api/src/modules/dashboard/dashboard.module.ts:86–147` |
| Təchizatçı reyestri, performans qiymətləndirməsi və sənədlərlə yoxlama | `apps/web/src/guides.ts:207–224`; `scripts/produce-guides.mjs:444–460` |
| Əlavə edilən və tətbiq istifadəçisinin dəyişə bilmədiyi audit qeydləri | `apps/api/src/common/audit/audit.service.ts:6–7,22–43` |
| İzah edilən yerli tövsiyə: qiymət, müddət, tarixçədən etibarlılıq | `apps/api/src/common/ai/ai-scorer.ts:34–103` |
| Ayrı AI xidməti və xidmət əlçatan olmadıqda yerli hesablama | `apps/api/src/common/ai/ai-scorer.ts:107–181` |
| Opsional LLM izahı deterministik sıralamaya əsaslanır | `services/ai-orchestrator/main.py:68–93,96–114` |
| OCDS 1.1 quruluşunda tender/nəticə ixracı | `apps/api/src/modules/sourcing/sourcing.service.ts:674–712` |
| UBL qaimə faylı ixracı | `apps/api/src/modules/invoices/invoices.module.ts:147–210` |
| 1C üçün uyğunlaşdırıla bilən CSV ixracı | `apps/api/src/modules/invoices/invoices.module.ts:119–137` |
| Azərbaycan, rus və ingilis dillərində bələdçilər | `apps/web/src/guides.ts:1–14`; `scripts/produce-guides.mjs:637–664` |

## Ekran görüntülərinin mənşəyi

İlkin material: `apps/web/public/guides/<bölmə>.az.png` və `apps/web/public/guides/<bölmə>.az.webm`. Bunlar mövcud məhsulun Azərbaycan dilində demo interfeysinin qeydləridir; yeni dizayn maketi və ya real müştəri məlumatı kimi təqdim olunmamalıdır.

Qeyd skripti `lp_lang=az` təyin edir, 1280×720 görünüş ölçüsündən istifadə edir, yardım vidcetini gizlədir və kursorsuz başlanğıc PNG yaradır: `scripts/produce-guides.mjs:642–665`. Video səhnələri həmin səhifələrdə hərəkətləri göstərir: `scripts/produce-guides.mjs:669–681`.

Bu təqdimatın `assets/` qovluğundakı `*.az.png` faylları uyğun ilkin PNG-lərə istinad edir. `<bölmə>-<saniyə>s.png` adları uyğun `<bölmə>.az.webm` videosundan seçilmiş kadrın saniyəsini göstərir. Dəqiq slayd seçimi vizual yoxlamaya əsaslanmalıdır; ssenari mətni təkbaşına kadra zəmanət vermir.

| Görüntü ailəsi | Mənbə və istifadə |
|---|---|
| `buyer-dashboard.az.png`, `sup-dashboard.az.png` | Alıcı və təchizatçı iş sahələrinin ilkin ekranları |
| `buyer-requests.az.png` | Satınalma tələbinin daxil edilməsi və reyestr |
| `buyer-events.az.png` | Tender reyestri; təklif detallarını göstərən ekran deyil |
| `buyer-events-17s.png`, `buyer-events-28s.png`, `buyer-events-40s.png`, `buyer-events-54s.png`, `buyer-events-68s.png`, `buyer-events-84s.png` | `buyer-events.az.webm`; tamamlanmış server tenderi, açılmış təkliflər, davam edən mebel tenderi və xatırlatmalar. Səhnələr: `scripts/produce-guides.mjs:309–375` |
| `buyer-settings-43s.png`, `buyer-settings-78s.png` | `buyer-settings.az.webm`; metod siyasəti və təsdiq qaydalarının səhnələri: `scripts/produce-guides.mjs:462–509` |
| `buyer-contracts.az.png`, `sup-orders.az.png`, `sup-orders-18s.png` | Müqavilə/PO reyestri və dəyişiklik razılaşdırılması; video səhnələri: `scripts/produce-guides.mjs:377–388,547–558` |
| `buyer-invoices.az.png`, `buyer-invoices-18s.png`, `buyer-invoices-30s.png` | Qaimələr və üzləşdirmə; video səhnələri: `scripts/produce-guides.mjs:390–401` |
| `sup-auction-14s.png`, `sup-auction-26s.png` | `sup-auction.az.webm`; auksion kartı. İlkin `sup-auction.az.png` tender reyestrini göstərə bilər. Səhnələr: `scripts/produce-guides.mjs:573–584` |
| `buyer-catalogs.az.png`, `buyer-budgets.az.png`, `buyer-analytics.az.png` | Kataloq, büdcə və xərc analitikası |
| `buyer-suppliers.az.png`, `buyer-verification.az.png`, `sup-verification.az.png` | Təchizatçı reyestri və sənəd yoxlaması |
| `buyer-logistics.az.png` | Təchizatçı tərəfindən daxil edilmiş göndəriş və status məlumatları |

Şəkillərdəki tarixi demo rəqəmləri indiki kommersiya nəticəsi deyil. Oxunaqlılıq üçün kəsim və miqyas dəyişə bilər; məlumatı dəyişən retuş edilməməlidir. Slaydda böyüdülən hissə məhz həmin ekran görüntüsündən götürülməlidir.

## İddiaların sərhədləri

| Mövzu | Təqdimatda düzgün məna və məhdudiyyət |
|---|---|
| ASAN İmza | Cari bağlama `DevSignatureProvider`-dır. Real ASAN bağlantısı işlək funksiya kimi göstərilməsin. Mənbə: `apps/api/src/common/signature/signature.provider.ts:5–9,17–35`. |
| AI | Tövsiyə və izah; yekun qərar alıcıdadır. LLM izahı konfiqurasiyadan asılıdır. Avtonom satınalma, bazar qiymətinin proqnozu və bütün bazarda təchizatçı axtarışı iddia edilməsin. |
| Formal qiymətləndirmə | Tender meyarları üzrə verilən ballar AI-nin ayrıca tövsiyə modeli ilə eyniləşdirilməsin. |
| Büdcə | Aşımı göstərir və xəbərdarlıq edir; sərt bloklama və bank qalığına nəzarət vəd edilməsin. |
| Ödəniş | PAID statusunun qeydiyyatıdır; bank köçürməsi deyil. Mənbə: `apps/api/src/modules/invoices/invoices.module.ts:292–295`. |
| 1C/ERP | 1C üçün CSV ixracı mövcuddur; tam CommerceML və ya ikiistiqamətli canlı ERP sinxronlaşdırılması deyil. |
| Peppol/UBL | UBL faylı ixrac olunur. Peppol şəbəkəsində göndəriş üçün ayrıca Access Point qoşulması lazımdır; sertifikatlaşdırılmış mübadilə iddia edilməsin. Mənbə: `apps/api/src/modules/invoices/invoices.module.ts:147–148`. |
| OCDS | Kod tender/nəticə quruluşu ixrac edir; bütün sahələrin və hər xarici validatorun tələblərinin tam ödənməsi yoxlanılmayıb. |
| E-poçt/WhatsApp | SMTP və Meta Cloud adapterləri var; işə düşməsi təşkilatın kanal qurulmasından və uyğun şablonlardan asılıdır. Canlı çatdırılma bu işdə yoxlanılmayıb. Mənbə: `apps/api/src/modules/channels/channels.module.ts:30–78`. |
| KYC | Təchizatçının sənəd təqdim etməsi və alıcının qərarıdır; dövlət reyestrinin avtomatik yoxlaması deyil. |
| Logistika | Təchizatçının qeyd etdiyi hadisələri göstərir; GPS və daşıyıcı sisteminin avtomatik inteqrasiyası iddia edilməsin. |
| Analitika | Xərc göstəricisi ACCEPTED PO-lara əsaslanır; bank çıxarışı və maliyyə hesabatı deyil. Birbaşa PO-lar kateqoriyasız qrupda qala bilər. Mənbə: `apps/api/src/modules/dashboard/dashboard.module.ts:86–108`. |
| Məxfilik və audit | Məhsul rolları, şifrələmə və dəyişdirilməyən tətbiq auditini izah edin. “Heç kim heç vaxt daxil ola bilməz”, “sıfır risk” və müstəqil təhlükəsizlik sertifikatı iddia edilməsin. |
| Beynəlxalq standartlar | Format və layihələndirmə istiqamətləridir; ISO sertifikatı, hüquqi uyğunluq zəmanəti və UNCITRAL təsdiqi göstərilməsin. |
| Yerləşdirmə | README bulud və öz infrastrukturunda yerləşdirmə variantını təsvir edir; konkret müqavilə, SLA, dəstək səviyyəsi və çatdırılma müddəti ayrıca razılaşdırılır. |
| Demo nəticəsi | 9,65% yalnız yuxarıdakı smeta və təklif fərqidir; real müştəri qənaəti və ya məhsul zəmanəti deyil. |
| Pilot | Təklif olunan növbəti addım kimi göstərilə bilər; razılaşdırılmamış tarix, müddət və öhdəlik əlavə edilməsin. |

## Təklif olunan təqdimat ardıcıllığı

1. Leadprocure — satınalmanın bütün mərhələləri bir platformada.
2. Tələbatdan ödənişin uçotuna qədər.
3. Hər rol üçün aydın iş sahəsi.
4. Nə diqqət tələb edir — bir ekranda.
5. Satınalma tələbi qaydalara uyğun başlayır.
6. Təsdiq səlahiyyətləri ayrılır.
7. Hər ehtiyaca uyğun satınalma üsulu.
8. Nümayiş nümunəsi: data mərkəzi üçün avadanlıq.
9. Məxfi təkliflər, bərabər şərtlər.
10. Qiymətləndirmə və əsaslandırılmış qərar.
11. Revers-auksion: qiymət rəqabəti canlı görünür.
12. Təchizatçı cavablarının izlənməsi və xatırlatmalar.
13. Müqavilədən çatdırılmaya qədər izlənən proses.
14. Sifariş, qəbul və qaimə birlikdə yoxlanır.
15. Təkrar satınalmalar üçün razılaşdırılmış kataloqlar.
16. Büdcə və faktiki xərc ayrı görünür.
17. Təchizatçı reyestri, sənədlər və performans tarixçəsi.
18. Azərbaycan dilində iş mühiti, bələdçilər və məlumat ixracı.
19. Bir pilot satınalma ilə başlayın.

Bu ardıcıllıq redaktə təklifidir; yekun təqdimatın slayd sayı və düzümü dizayn zamanı uyğunlaşdırıla bilər.

## Əlavə redaktə istiqaməti — korporativ auditoriya və məhsul məlumat vərəqi

26 oktyabr 2026 tarixli istifadəçi dəqiqləşdirməsi: təqdimat peşəkar korporativ auditoriyaya yönəlməli, revers-auksion və fərqləndirici imkanlar vurğulanmalı, daha sonra məhsul məlumat vərəqi hazırlanmalıdır. Vizual istiqamət: isti ağ, qrafit və zümrüd yaşıl; tünd göy istifadə edilməməlidir. Əvvəlki ümumi hekayə korporativ qərarverənin satınalma nəzarəti, proses şəffaflığı və təchizatçı iştirakı suallarına uyğun sıralana bilər.

İki səhifəlik məhsul məlumat vərəqinin Azərbaycan dilində məzmunu `docs/presentations/leadprocure-az/datasheet-content.json` faylındadır. Məzmun məhsul xülasəsi, hədəf alıcı, 10 əsas imkan, rollar, dillər, yerləşdirmə, məlumat mübadiləsi, təhlükəsizlik nəzarətləri və funksional şərtlər kimi ayrılıb. Birinci səhifədə əsas imkanları, ikinci səhifədə yerləşdirmə və inteqrasiya əhatəsini göstərmək uyğundur.

### Təqdim edən şəxs üçün qeydlər

- Revers-auksionu göstərərkən: “Bu ssenaridə təchizatçılar cari ən yaxşı təklifdən müəyyən addımla aşağı qiymət verir. Son anda gələn təklif üçün uzadılma qaydası əvvəlcədən müəyyən edilir. Məqsəd qaydaları hamı üçün aydın olan qiymət rəqabətidir.” Təmin edilmiş qənaət vədi verməyin.
- Məxfi tenderi göstərərkən: “Auksionda qiymət rəqabəti görünür; RFQ/RFP-də isə kommersiya təklifləri açılışa qədər alıcıdan gizlidir. Satınalmanın növünə uyğun prosedur seçilir.” Bunlar iki fərqli iş rejimidir.
- Təsdiq və qiymətləndirmədə: “Proses yalnız statuslar zənciri deyil: tələbin müəllifi, təsdiqləyən şəxs və seçim qərarı üçün məsuliyyətlər ayrılır. Meyarlar təkliflər açılmamış müəyyən edilir.”
- Təkliflərin müqayisəsində: “51 500 AZN təklifin 21 günlük, 54 600 AZN təklifin isə 14 günlük çatdırılma müddəti var. Seçim tələb olunan qiymət–müddət tarazlığı və əvvəlcədən müəyyən edilmiş qiymətləndirmə üzrə aparılır.” Formal balları AI tövsiyəsinin balları kimi təqdim etməyin.
- Maliyyə nəzarətində: “Büdcə tələblərin planlaşdırılan təsirini, xərc analitikası qəbul edilmiş sifarişləri, qaimə isə öhdəliyin sənədləşdirilməsini göstərir.” Bu göstəricilərin fərqli mərhələlərə aid olduğunu izah edin.
- İnteqrasiyalar barədə: “Hazır fayl ixracı ilə xarici şəbəkəyə qoşulma fərqli əhatədir. Müştərinin mövcud sistemləri və tələb etdiyi mübadilə ssenarisi pilotun əhatəsi müəyyən edilərkən ayrıca dəqiqləşdirilir.”
- Son slaydda: “İlk addım kimi bir kateqoriya və bir satınalma prosesi üzərində iş qaydalarını uyğunlaşdıraq.” Müştərinin təsdiqi olmadan tarix, qiymət və nəticə öhdəliyi bildirməyin.
