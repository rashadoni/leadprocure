# Leadprocure — məruzəçi qeydləri

## 01. Satınalmanı vahid sistemdə idarə edin

Leadprocure korporativ satınalma komandasını, təsdiqləyənləri və təchizatçıları vahid prosesdə birləşdirir. Bu təqdimat funksiyaları real demo ekranları ilə göstərir. Məhsulun təqdimatı, 26 oktyabr 2026.

Mənbələr: README.md:3–33; docs/DEMO.md:23–34

## 02. Korporativ satınalmanın üç əsas sualına cavab

Faydalar məhsul funksiyalarından çıxarılan əməliyyat dəyəridir; ölçülmüş müştəri ROI-si və ya zəmanətli qənaət təqdim edilmir.

Mənbələr: apps/api/src/modules/requests/requests.module.ts; apps/api/src/modules/dashboard/dashboard.module.ts; apps/api/src/modules/contracts/contracts.module.ts

## 03. Sadəcə tender reyestrindən daha geniş imkanlar

Bu altı funksiya təqdimatın əsas məhsul fərqləndiriciləridir. Ətraflı nümunələr növbəti slaydlardadır.

Mənbələr: apps/api/src/modules/sourcing/auction.service.ts; apps/api/src/common/crypto/sealed.service.ts; apps/api/src/modules/requests/requests.module.ts; apps/api/src/modules/invoices/invoices.module.ts; apps/api/src/modules/followups/followups.module.ts

## 04. Bir proses. İki tərəf. Aydın məsuliyyət.

PO — satınalma sifarişidir. Ödəniş mərhələsi sistemdə uçot/status qeydini bildirir, bank köçürməsini deyil.

Mənbələr: docs/DEMO.md:23–34; apps/web/src/main.tsx:46–78

## 05. Görüləcək işlər bir idarə panelində

Ekranda demo satınalma həcmi, qənaət, aktiv tenderlər, təsdiq gözləyən tələb və büdcə xəbərdarlığı göstərilir.

Mənbələr: apps/web/src/guides.ts:15–43; apps/api/src/modules/dashboard/dashboard.module.ts:15–47

## 06. Satınalma dəqiq tələbatdan başlayır

İnterfeysdə daxili satınalma tələbi “Sifarişlər”, purchase order isə “Sifarişlər (PO)” kimi göstərilir. Təqdimatda qarışıqlığı azaltmaq üçün “tələbat” və “PO” ayrılır.

Mənbələr: apps/api/src/modules/requests/requests.module.ts:170–227; scripts/demo-fill.mjs:197–201

## 07. Təsdiq prosesi aydın qaydalara əsaslanır

Müəllif öz tələbini təsdiqləyə bilməz; bir şəxs eyni tələbin iki təsdiq addımını bağlaya bilməz. Şəkildəki hədlər demo konfiqurasiyasıdır, universal hüquqi limit deyil.

Mənbələr: apps/api/src/modules/requests/requests.module.ts:177–201; scripts/produce-guides.mjs:462–509

## 08. Hər ehtiyac üçün uyğun prosedur

RFI məlumat toplamaq üçündür; qiymət üzrə qalib seçimi və müqavilə mükafatı üçün nəzərdə tutulmur. Birbaşa sifarişin uyğunluğu təşkilat siyasətindən asılıdır.

Mənbələr: apps/web/src/guides.ts:66–74; apps/api/src/modules/sourcing/sourcing.service.ts:349–355

## 09. Qiymətlər açılışa qədər qorunur

Bu ekran TƏCHİZATÇI kabinetidir: öz qiymətini görməsi normaldır. Alıcı məbləği açılışa qədər görə bilmir. Təklifin məbləği şifrələnir; ümumi sual-cavab bütün uyğun iştirakçılar üçün eyni məlumatı təmin edir.

Mənbələr: apps/api/src/common/crypto/sealed.service.ts:5–33; apps/api/src/modules/sourcing/sourcing.service.ts:327–415; scripts/produce-guides.mjs:520–545

## 10. 57 000 AZN smetadan 51 500 AZN təklifə

Rəqəmlər scripts/demo-fill.mjs-dəki nümayiş ssenarisindəndir. Bu, real müştəri nəticəsi və ya qənaət zəmanəti deyil. Qiymətlər ƏDV-sizdir. 5 500 / 57 000 = 9,6491%, iki onluğa yuvarlaq 9,65%.

Mənbələr: scripts/demo-fill.mjs:197–246

## 11. Qalib seçiminin məntiqi görünür

Demoda meyarlar qiymət 70%, çatdırılma 30%-dir; Supply One 95×0,7+75×0,3=89; Baku Metal 82×0,7+90×0,3=84,4. AI tövsiyəsi ayrıca dəstək funksiyasıdır, bu cədvəldəki rəsmi qiymətləndirmənin əvəzi deyil. Yekun qərar alıcıdadır.

Mənbələr: apps/api/src/modules/sourcing/sourcing.service.ts:485–618; scripts/demo-fill.mjs:218–230; services/ai-orchestrator/main.py:68–114

## 12. Rəqabət qiyməti addım-addım aşağı salır

Auksion nümunəsi dizel yanacağı üçündür. Şəkildə start 32 000, ən yaxşı qiymət 31 200, növbəti maksimum 30 880 AZN-dir. Son saniyədə təklif veriləndə qaydaya əsasən vaxt uzadılır. Nəticə nümunədir.

Mənbələr: apps/api/src/modules/sourcing/auction.service.ts:98–111,164–200; scripts/produce-guides.mjs:573–584

## 13. Dəvətdən cavaba qədər izləmə avtomatlaşdırılır

SMTP və WhatsApp/Meta kanalları ayrıca sazlanır. Təklif verildikdə xatırlatma zənciri dayanır. Burada canlı mesaj göndərilməsi yoxlanılmayıb; göstərilən demo planıdır.

Mənbələr: apps/api/src/modules/followups/followups.module.ts:186–249; apps/api/src/modules/channels/channels.module.ts:30–79; apps/api/src/modules/sourcing/sourcing.service.ts:413–415

## 14. Qalib təklif icra edilən sifarişə çevrilir

Müqavilə qalib tender əsasında yaranır. PO-nun təsdiq, qablaşdırma, göndəriş, çatdırılma və qəbul mərhələləri var. Logistika hadisələrini təchizatçı daxil edir; GPS və ya daşıyıcı inteqrasiyası iddia edilmir.

Mənbələr: apps/web/src/guides.ts:110–129; apps/api/src/modules/logistics/logistics.module.ts

## 15. Sifarişdə dəyişiklik qarşı tərəfin razılığı ilə

İkinci nümayiş nümunəsi: A4 kağız 40×7=280 AZN-dən 60×7=420 AZN-ə dəyişir. Təchizatçı qəbul və ya rədd edir. Məbləğ yalnız qəbuldan sonra yenilənir. Sifariş dəyişiklikləri üçün status və qəbul şərtləri mövcuddur.

Mənbələr: scripts/demo-fill.mjs:307–315; scripts/produce-guides.mjs:547–558

## 16. Sifariş, qəbul və qaimə üçtərəfli yoxlanılır

Sistem sifariş, qəbul edilmiş miqdar və qaimə sətirlərini üzləşdirir. Uyğunsuzluq DISPUTED statusu yaradır. Qəbul sonradan daxil edilərsə, yoxlama yenilənir. PAID yalnız ödənişin uçotudur, bank əməliyyatı deyil. Demo ƏDV hesabı 51 500×18%=9 270; cəmi 60 770.

Mənbələr: apps/api/src/modules/invoices/invoices.module.ts:32–84,214–220,292–295; apps/api/src/modules/contracts/contracts.module.ts:320–327; scripts/demo-fill.mjs:237–246

## 17. Razılaşdırılmış qiymətlərlə təkrar sifariş verin

Aktiv kataloq müqavilədən yaradıla və ya razılaşdırılmış qiymətləri saxlaya bilər. Sifarişdə qiymət və minimum miqdar yoxlanılır. Bunlar təşkilatın münasibət və lisenziya qaydalarına tabedir.

Mənbələr: apps/web/src/guides.ts:143–153; apps/api/src/modules/catalogs/catalogs.module.ts

## 18. Plan, öhdəlik və faktiki xərc ayrı görünür

Büdcə istifadəsi təsdiqlənmiş tələblərin öhdəliyi əsasında hesablanır, analitikada xərc isə ACCEPTED PO-lardır. Aşım xəbərdarlığı avtomatik bloklama deyil. Demo ekranlarındakı qənaət real müştəri nəticəsi sayılmır.

Mənbələr: apps/api/src/modules/budgets/budgets.module.ts:30–63,114–137; apps/api/src/modules/dashboard/dashboard.module.ts:86–147

## 19. Təchizatçı bazasını sənəd və nəticə ilə qiymətləndirin

KYC burada sənədlərin toplanması və alıcının qərarıdır; dövlət reyestrinə avtomatik sorğu deyil. Reytinq vaxtında çatdırılma, keyfiyyət və kommunikasiya qiymətlərini toplayır.

Mənbələr: apps/web/src/guides.ts:207–232; apps/api/src/modules/verification/verification.module.ts

## 20. Korporativ tələblərə uyğun iş mühiti

RLS/ACL, AES-256-GCM və append-only audit kod səviyyəsində nəzərdə tutulmuş nəzarətlərdir. Sertifikasiya, penetrasiya testinin yeni nəticəsi və ya canlı SLA iddia edilmir. Yerləşdirmə və funksiyalar lisenziya və texniki konfiqurasiyadan asılıdır.

Mənbələr: README.md:3–33; infra/DEPLOY.md:1–63; apps/api/src/common/crypto/sealed.service.ts:5–33; apps/api/src/common/audit/audit.service.ts:6–43

## 21. Məlumat mübadiləsi və qoşulma imkanları

OCDS ixracı tender və qalib məlumatları üçündür. UBL faylı Peppol şəbəkəsi vasitəsilə öz-özünə göndərilmir; Access Point tələb olunur. 1C üçün CSV var, iki tərəfli sinxronizasiya deyil. ASAN İmza operator inteqrasiyası tələb edir; hazırda development provider işləyir.

Mənbələr: apps/api/src/modules/sourcing/sourcing.service.ts:674–712; apps/api/src/modules/invoices/invoices.module.ts:119–148; apps/api/src/modules/channels/channels.module.ts:30–79; apps/api/src/common/signature/signature.provider.ts:5–35

## 22. Bir pilot satınalma ilə dəyəri ölçün

Bu, təklif olunan pilot planıdır; müqavilə öhdəliyi, qiymət və ya müddət zəmanəti deyil. Qiymətləndirmə meyarları müştəri ilə əvvəlcədən razılaşdırılmalıdır.

Mənbələr: Təklif olunan müştəri pilot planı — müəllif tövsiyəsi
