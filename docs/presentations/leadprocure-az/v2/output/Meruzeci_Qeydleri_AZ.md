# Leadprocure — Məruzəçi qeydləri

13 slayd · Monograph · Azərbaycan dili

## 01. Satınalmanı strateji üstünlüyə çevirin.

Söhbətə proqramın menyusundan başlamayın. Satınalma rəhbəri üçün düzgün təchizatçı seçimi, maliyyə rəhbəri üçün xərc və öhdəliklərin görünməsi, əməliyyat komandası üçün isə razılaşdırılan şərtlərin icrası vacibdir. Leadprocure bu üç baxışı bir satınalma prosesinə bağlayır. Təqdimatda həmin nəzarətin necə qurulduğunu göstərəcəyik; interfeysi və əməliyyat addımlarını ayrıca canlı nümayişdə açacağıq. Bu təqdimat ölçülmüş müştəri nəticəsi və ya qənaət zəmanəti irəli sürmür.

Mənbələr: README.md:3–33; docs/DEMO.md:23–34

## 02. Hər qərar görünür. Hər mərhələ nəzarətdədir.

Bu slayd rəhbərlik üçün üç biznes baxışını birləşdirir. Xərc şəffaflığı büdcə öhdəliyindən qəbul edilmiş sifarişlər üzrə faktiki xərcə qədər məlumatı göstərir. Rəqabətli seçim dəvət, tender və ya auksion, əvvəlcədən müəyyən edilmiş meyarlar və əsaslandırılmış qərara söykənir. İcra intizamı razılaşdırılan şərtləri sifariş, çatdırılma və qəbul mərhələlərinə bağlayır. Bunlar ölçülmüş müştəri nəticələri deyil; platformanın funksiyaları ilə dəstəklənən idarəetmə imkanlarıdır. Növbəti slaydlarda həmin imkanları təmin edən nəzarət mexanizmlərini göstəririk.

Mənbələr: apps/api/src/modules/dashboard/dashboard.module.ts:86–147; apps/api/src/modules/sourcing/sourcing.service.ts:485–618; apps/api/src/modules/contracts/contracts.module.ts:90–118,166–197

## 03. Satınalma qaydaları qərardan əvvəl müəyyən edilir

Burada iki nəzarəti ayırın. Birincisi, daxili tələbin təsdiqidir: məbləğ siyasəti təsdiq addımlarını müəyyən edə bilər; müəllif öz tələbini təsdiqləyə bilmir və bir şəxs eyni tələbin iki təsdiq addımını bağlamır. İkincisi, tender qiymətləndirməsidir: meyarlar və çəkilər tender yaradılarkən müəyyən edilir. Qiymətlər açıldıqdan sonra onlara uyğun meyar dəyişdirmək mümkün deyil. Qiymətləndirmədə birinci olmayan təklifin seçilməsi, eləcə də yalnız bir uyğun təklif olan hal əsaslandırma tələb edir. Bunlar proqramda konkret tətbiq olunan nəzarətlərdir; hüquqi sertifikasiya vədi deyil.

Mənbələr: apps/api/src/modules/requests/requests.module.ts:177–201; apps/api/src/modules/sourcing/sourcing.service.ts:94–107,485–519,558–585

## 04. Rəqabət təchizatçının prosesə qoşulmasından başlayır

Satınalma komandası dəvətin göndərildiyini və təklifin gəldiyini ayrı-ayrı izləyir. Cavab verməmiş dəvətli təchizatçılar üçün xatırlatma ardıcıllığı qurmaq mümkündür. Təklif təqdim ediləndə həmin təchizatçının zənciri dayanır; alıcı onu əl ilə də dayandıra bilər. Sual-cavab bölməsində alıcının cavabı uyğun iştirakçılara eyni məlumatı verir. E-poçt və WhatsApp kanalları təşkilatın sazlamalarından asılıdır; canlı göndəriş bu təqdimat işi çərçivəsində yoxlanılmayıb. İştirak sayının və cavab faizinin artacağına dair rəqəmli zəmanət verilməməlidir.

Mənbələr: apps/api/src/modules/followups/followups.module.ts:92–147,186–249; apps/api/src/modules/sourcing/sourcing.service.ts:413–415; scripts/produce-guides.mjs:539–545

## 05. Təkliflər açılanadək qiymətlər məxfidir

Məxfi tender ilə revers-auksion ayrı rejimlərdir. Bu slayd məxfi RFQ və RFP-yə aiddir: alıcı açılışa qədər iştirak faktını görə bilər, lakin qiymət məbləğlərini görmür. Təchizatçı isə öz təklifini görə və son tarixə qədər qaydalara uyğun idarə edə bilər. Maliyyə məzmunu AES-256-GCM ilə şifrələnir; RFP-də texniki təklif də həmin məxfi məzmuna daxildir. Açılışdan sonra qiymətlər və qiymətləndirmə üçün məlumatlar görünür. “Heç bir səlahiyyətli sistem administratoru məlumatı heç vaxt əldə edə bilməz” kimi mütləq təhlükəsizlik iddiası işlətməyin.

Mənbələr: apps/api/src/common/crypto/sealed.service.ts:5–7,23–33; apps/api/src/modules/sourcing/sourcing.service.ts:327–415,435–479

## 06. Revers-auksion: rəqabət real vaxtda.

Bu, təqdimatın əsas vurğu nöqtəsidir; qrafiki bir qədər dayanaraq izah edin. Təchizatçı cari ən yaxşı məbləği və növbəti qəbul edilə bilən həddi görür. Yeni təklif həmin həddən yuxarı olduqda qəbul edilmir. Son anda gələn təkliflər üçün sistem müəyyən edilmiş qayda daxilində vaxtı uzada bilər. Uzadılma məhduddur. Bu rejimdə qiymətlər məxfi zərf kimi bağlı deyil, rəqabətin gedişi görünür. Qrafik yalnız mexanizmi izah edir; konkret qənaət və ya təklif sayı vəd etmir. Uyğun kateqoriyanın və qaydaların seçimi müştərinin satınalma məqsədindən asılıdır. Slayddakı illüstrativ auksionda başlanğıc məbləğ 32 000 AZN, cari ən yaxşı təklif 31 200 AZN-dir. Minimum endirim addımı 320 AZN olduqda növbəti təklif ən çox 30 880 AZN ola bilər: 31 200 − 320 = 30 880. Son rəqəm artıq daxil olmuş təklif deyil; buna görə son pillə punktirlə göstərilib. Bu rəqəmlər növbəti RFQ nümunəsinin nəticəsi ilə əlaqələndirilməməlidir.

Mənbələr: apps/api/src/modules/sourcing/auction.service.ts:98–111,131–132,164–183,198–205

## 07. Seçimi rəqəmlərlə görünən edin

Bu nümunə məhsulun demo ssenarisindən götürülüb; real müştəri uğur hekayəsi deyil. Dörd server üçün smeta vahid başına 12 000 AZN, iki kommutator üçün 4 500 AZN-dir: cəmi 57 000 AZN. Supply One təklifi 51 500 AZN və 21 günlük çatdırılma, Baku Metal təklifi isə 54 600 AZN və 14 günlük çatdırılmadır. Nümunədə qiymət və çatdırılma meyarları üzrə formal qiymətləndirmədən sonra Supply One seçilir. Fərq 5 500 AZN, yəni smetanın təxminən 9,65%-idir. Bu slayd məxfi RFQ nümunəsidir; əvvəlki auksion slaydının faktiki nəticəsi kimi təqdim edilməməlidir.

Mənbələr: scripts/demo-fill.mjs:197–230

## 08. AI tövsiyəsi. Qərar sizdədir.

Bu funksiya əvvəlcədən müəyyən edilmiş tender meyarları ilə aparılan formal qiymətləndirməni əvəz etmir. Ayrı dəstək modeli açılmış təklifləri qiymət, çatdırılma müddəti və təchizatçının performans tarixçəsi əsasında sıralayır, səbəbləri göstərir. Cari yerli modeldə çəkilər 50% qiymət, 20% müddət, 30% etibarlılıqdır; formal demo qiymətləndirməsinin 70/30 çəkiləri ilə qarışdırılmamalıdır. Ayrı AI xidməti konfiqurasiya olunarsa LLM izahı əlavə oluna bilər; xidmət əlçatan olmadıqda yerli modelə keçid var. Avtonom satınalma, bazar proqnozu və ya təsdiqsiz qalib seçimi iddia edilməməlidir.

Mənbələr: apps/api/src/common/ai/ai-scorer.ts:34–103,107–181; services/ai-orchestrator/main.py:68–114

## 09. Razılaşdırılan şərtlər icra boyu izlənir

Təchizatçı seçildikdən sonra proses davam edir. Müqavilə qalib tender əsasında yaradılır, onun üzrə sifariş verilir və icra mərhələləri izlənir. Miqdar və ya qiymət dəyişməlidirsə, alıcı düzəliş təklif edir; təchizatçı köhnə və yeni şərtləri görərək qəbul və ya rədd edir. Məbləğ yalnız razılıqdan sonra yenilənir, dəyişiklik tarixçəsi saxlanılır. Bu əməliyyatın sifariş statusu və mal qəbulunun başlamaması kimi şərtləri var. Logistika hadisələri təchizatçı tərəfindən qeyd edilir; avtomatik GPS və daşıyıcı inteqrasiyası kimi izah edilməməlidir.

Mənbələr: apps/web/src/guides.ts:110–129; apps/api/src/modules/contracts/contracts.module.ts:354–428; scripts/produce-guides.mjs:377–388,547–558

## 10. Qaimə sifariş və faktiki qəbulla üzləşdirilir

Sistem qaimənin qiymət və miqdarını sifarişlə, qəbul edilmiş və daha əvvəl qaimələnmiş miqdarla müqayisə edir. Uyğunsuzluq olduqda DISPUTED statusu yaranır. Qəbul sonradan rəsmiləşdirilərsə yoxlama yenidən hesablanır. Mübahisəli qaimənin təsdiqinə istisna tətbiq ediləndə səbəb tələb olunur. Bu, üç sənədi əlaqələndirən əməliyyat nəzarətidir; hər biznes halını avtomatik həll edən zəmanət kimi təqdim edilməsin. Ödəniş statusunun qeydi mövcuddur, lakin bank köçürməsini məhsulun özünün icra etdiyi deyilməməlidir.

Mənbələr: apps/api/src/modules/invoices/invoices.module.ts:32–84,214–220,292–295; apps/api/src/modules/contracts/contracts.module.ts:320–327

## 11. Büdcə öhdəliyi ilə faktiki xərc ayrı görünür

Büdcə istifadəsi kateqoriya, il və valyuta üzrə uyğun təsdiqlənmiş tələblərdən hesablanır. Bu göstərici bank hesabındakı qalıq və ya ödənilmiş məbləğ deyil. Xərc analitikası isə qəbul edilmiş PO-lara əsaslanır; aylar, kateqoriyalar, əsas təchizatçılar və qaimə statusları üzrə baxış verir. Büdcə aşımı xəbərdarlıq yaradır, təsdiqi avtomatik bloklamır. Müştəriyə bu fərqi açıq izah edin: platforma qərar üçün görünürlük verir və mövcud qaydaları tətbiq edir; maliyyə siyasətinin bütün sərt bloklama tələblərinin artıq hazır olduğunu vəd etmir.

Mənbələr: apps/api/src/modules/budgets/budgets.module.ts:30–63,114–137; apps/api/src/modules/dashboard/dashboard.module.ts:86–147

## 12. Bir proses. Üç rəhbərlik baxışı.

Burada funksiyaları yenidən sadalamayın. Əvvəlki mexanizmləri rəhbərlik baxışına qaytarın: maliyyə üçün büdcə öhdəlikləri və qəbul edilmiş sifarişlər; satınalma üçün rəqabət, qiymətləndirmə və seçim əsasları; əməliyyat üçün sifariş, dəyişiklik və qəbul vəziyyəti. Audit qeydləri əsas əməliyyatların izlənməsini dəstəkləyir. Bunlar məlumat və nəzarət imkanlarıdır; konkret müştərinin nə qədər vaxt və vəsait qənaət edəcəyi pilotda ölçülməlidir. Texniki yerləşdirmə, dillər, inteqrasiya şərtləri və əlavə modullar ayrıca məhsul məlumat vərəqində müzakirə oluna bilər.

Mənbələr: apps/api/src/modules/dashboard/dashboard.module.ts:15–47,86–147; apps/api/src/common/audit/audit.service.ts:6–7,22–43; apps/api/src/modules/sourcing/sourcing.service.ts:533–618

## 13. Dəyəri bir real satınalma ilə ölçək

Növbəti addımı konkret, lakin əvvəlcədən öhdəlik yaratmadan təklif edin. Bir satınalma kateqoriyası, bir proses, məsul komanda və seçilmiş təchizatçılar kifayətdir. Başlamazdan əvvəl rollar, təsdiq qaydaları, prosedur və qiymətləndirmə meyarları razılaşdırılır. Pilotda proses müddəti, iştirak, smetaya nisbətən fərq və üzləşdirmədə görünən uyğunsuzluqlar izlənə bilər. Hədəf rəqəmləri və qəbul meyarları müştəri ilə birlikdə müəyyən edilir. Sonra genişləndirmənin əhatəsi, yerləşdirmə və inteqrasiyalar müzakirə olunur. Bağlanış cümləsi: “Şirkətinizdə ilk pilot üçün hansı satınalma kateqoriyası daha uyğundur?”

Mənbələr: Müəllifin təklif etdiyi pilot yanaşması; məhsul göstəricisi və ya müqavilə öhdəliyi deyil.
