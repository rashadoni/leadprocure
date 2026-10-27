# Leadprocure — Məhsul məlumat vərəqi

Korporativ satınalma və təchizatçı əməkdaşlığı platforması

## Səhifə 1 — Məhsul və əsas imkanlar

Satınalma tələbindən tenderə, müqavilədən sifariş, qəbul və qaiməyə qədər vahid iş prosesi. Leadprocure məsul şəxsləri, qərarları və əməliyyat məlumatlarını əlaqələndirərək satınalma, maliyyə və əməliyyat komandalarına ortaq baxış verir.

Daxili təsdiq qaydaları, rəqabətli seçim və təchizatın icrası üzərində sistemli nəzarət qurmaq istəyən müəssisələr və korporativ satınalma komandaları.

### 01. Revers-auksion

Cari ən yaxşı qiymət və növbəti maksimum təklif həddi iştirakçıya görünür. Minimum endirim addımı və son anda gələn təkliflər üçün müddətin məhdud uzadılması qaydası tətbiq olunur.

### 02. Məxfi RFQ və RFP

Qiymət təklifi sorğusunda və texniki təklifli tenderdə məbləğlər açılışa qədər alıcıdan gizlidir. RFI ilə qiymətsiz məlumat toplamaq, ümumi sual-cavab bölməsində iştirakçıları məlumatlandırmaq mümkündür.

### 03. Təsdiq zəncirləri və səlahiyyət bölgüsü

Məbləğə görə satınalma metodu və təsdiq addımları müəyyən edilir. Müəllif öz tələbini təsdiqləmir; bir şəxs eyni tələbin iki təsdiq addımını yerinə yetirə bilmir.

### 04. Lotlar üzrə seçim və formal qiymətləndirmə

Meyarlar əvvəlcədən müəyyən edilir. Lotlar müxtəlif təchizatçılara verilə bilər. Qiymətləndirmədə birinci olmayan təklifin seçilməsi və yalnız bir uyğun təklifin olduğu hallar əsaslandırma tələb edir.

### 05. İzah edilən AI tövsiyəsi

Açılmış təkliflər qiymət, çatdırılma müddəti və təchizatçı tarixçəsi əsasında müqayisə olunur. Tövsiyə qərarı dəstəkləyir; formal qiymətləndirməni əvəz etmir və qalibi avtonom seçmir.

### 06. Təchizatçı reyestri və sənəd yoxlaması

Dəvət, təsdiq, bloklama və KYC sənədlərinin nəzərdən keçirilməsi bir prosesdə aparılır. Çatdırılma, keyfiyyət və kommunikasiya üzrə qiymətləndirmələr təchizatçının performans tarixçəsini formalaşdırır.

### 07. Müqavilələr, sifarişlər və qiymət kataloqları

Müqavilədən PO və qəbula qədər icra izlənir. Dəyişiklik təchizatçının razılığı ilə tətbiq olunur. Razılaşdırılmış qiymət kataloqları minimum miqdar yoxlaması ilə təkrar sifariş imkanı verir.

### 08. Qaimələrin üçtərəfli üzləşdirilməsi

Sifariş, faktiki qəbul və qaimə müqayisə edilir; qiymət və miqdar uyğunsuzluqları göstərilir. Mübahisəli qaimənin istisna olaraq təsdiqi əsaslandırılır. Ödəniş statusu uçota alınır.

### 09. Büdcə və xərc analitikası

Kateqoriya və il üzrə limitlər, təsdiqlənmiş tələblərin büdcəyə təsiri və aşım xəbərdarlıqları görünür. Qəbul edilmiş sifarişlər üzrə aylıq xərclər, kateqoriyalar və əsas təchizatçılar izlənir.

### 10. Planlı təchizatçı xatırlatmaları

Cavab verməmiş dəvətli təchizatçılar üçün e-poçt və WhatsApp ardıcıllıqları qurulur. Təklif daxil olduqda zəncir dayanır; alıcı xatırlatmaları əl ilə də dayandıra bilər.

## Səhifə 2 — Profil və tətbiq şərtləri

### Rollar

- Alıcı administratoru
- Təsdiqləyən şəxs
- Alıcı istifadəçisi
- Təchizatçı istifadəçisi

### Dillər

- Azərbaycan dili
- Rus dili
- İngilis dili

### Maliyyə məlumatları

- Valyuta və məbləğ uçotu; serverdə hesablanan yekunlar.
- VÖEN və mövqe üzrə ƏDV dərəcəsi; AZN ilə iş axını.

### Yerləşdirmə

**Bulud modeli.** Təşkilatlar üzrə məlumat ayrılması ilə SaaS yerləşdirmə.

**Müştərinin infrastrukturunda.** Öz infrastrukturunda yerləşdirmə və lisenziyalaşdırma; texniki əhatə ayrıca razılaşdırılır.

### Məlumat mübadiləsi

**UBL və OCDS.** UBL qaimə faylı və OCDS quruluşunda tender/nəticə məlumatlarının ixracı.

**1C üçün CSV.** Qaimələrin 1C-yə uyğunlaşdırıla bilən CSV faylı ilə ixracı.

**E-poçt və WhatsApp.** Təşkilatın SMTP və Meta WhatsApp Cloud kanalları ilə qoşulma.

### Nəzarət mexanizmləri

- Rollar üzrə əməliyyat səlahiyyətləri və təşkilatlar arasında məlumat ayrılması.
- Məxfi təkliflər üçün AES-256-GCM şifrələməsi və açılışa bağlı görünürlük.
- Təsdiq səlahiyyətlərinin ayrılması və əvvəlcədən müəyyən edilən qiymətləndirmə meyarları.
- Əsas əməliyyatlar üçün tətbiq istifadəçisinin dəyişə bilmədiyi audit qeydləri.
- Son təqdimetmə tarixinin və məbləğ hesablamalarının serverdə yoxlanılması.

### Funksiyaların tətbiq şərtləri

- Büdcə aşımı təsdiqi avtomatik bloklamır. Ödəniş statusunun qeydi bank köçürməsi deyil.
- CSV ixracı canlı ERP sinxronlaşdırılması deyil. Peppol şəbəkəsində göndəriş üçün ayrıca Access Point xidməti tələb olunur.
- Təchizatçı yoxlaması sənədlər və alıcının qərarına əsaslanır. Real ASAN İmza operator bağlantısı cari versiyada aktiv deyil.
- Xarici mesaj kanalları sazlamalar və uyğun şablonlar tələb edir. LLM izahı ayrıca konfiqurasiyadan asılıdır; yerli tövsiyə modeli mövcuddur.
- Modulların əlçatanlığı lisenziya və texniki konfiqurasiyadan asılıdır. Format dəstəyi sertifikatlaşdırma və ya hüquqi uyğunluq zəmanəti deyil.

### Pilot

Pilot üçün bir satınalma kateqoriyası seçilir; rollar, qaydalar və nəticənin qiymətləndirilməsi meyarları birlikdə müəyyən edilir.
