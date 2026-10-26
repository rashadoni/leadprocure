# Leadprocure
Müəssisələr üçün satınalma və təchizatçı əməkdaşlığı platforması

Daxili satınalma tələblərini, rəqabətli tenderləri, müqavilələri, sifarişləri və qaimə nəzarətini vahid iş prosesində birləşdirir. Alıcı və təchizatçı öz səlahiyyətləri daxilində eyni prosesin iştirakçısı olur.

## Əsas imkanlar
### Revers-auksion
Cari ən yaxşı qiymət, minimum endirim addımı və son anda verilən təkliflər üçün müddətin məhdud uzadılması ilə qiymət rəqabəti.

### Məxfi RFQ və RFP
Qiymət və texniki təkliflər açılışa qədər şifrələnir. RFI məlumat sorğusu və iştirakçılar üçün ümumi sual-cavab bölməsi də mövcuddur.

### Satınalma qaydaları və təsdiq zəncirləri
Məbləğə görə satınalma metodu və təsdiq addımları müəyyən edilir. Tələbin müəllifi öz tələbini təsdiqləyə bilmir.

### Lotlar üzrə seçim və qiymətləndirmə
Meyarlar əvvəlcədən müəyyən edilir; lotlar müxtəlif təchizatçılara verilə bilər. Qiymətləndirmədə birinci olmayan təklifin seçilməsi əsaslandırma tələb edir.

### Təchizatçı reyestri və yoxlama
Təchizatçı sənədləri, təsdiq və bloklama qərarları, çatdırılma, keyfiyyət və kommunikasiya üzrə performans qiymətləndirmələri bir yerdə saxlanılır.

### Müqavilədən malın qəbuluna qədər
Müqavilə əsasında sifariş, çatdırılma statusları və qəbul izlənir. Sifariş dəyişikliyi təchizatçının razılığından sonra tətbiq olunur.

### Qaimələrin üçtərəfli üzləşdirilməsi
Sifariş, faktiki qəbul və qaimə müqayisə edilir. Miqdar və qiymət uyğunsuzluqları təsdiqdən əvvəl görünür; ödəniş statusu uçota alınır.

### Büdcə görünürlüğü və xərc analitikası
Kateqoriya və il üzrə limitlər, təsdiqlənmiş tələblərin büdcəyə təsiri, qəbul edilmiş sifarişlər üzrə xərclər və tender nəticələri izlənir.

### Razılaşdırılmış qiymət kataloqları
Təkrar satınalmalar üçün təsdiqlənmiş təchizatçıların kataloqlarından sifariş verilir. Qiymət və minimum sifariş miqdarı sistem tərəfindən yoxlanılır.

### Təchizatçı xatırlatmaları
Cavab verməyən dəvətli təchizatçılar üçün e-poçt və WhatsApp ardıcıllıqları qurulur. Təklif təqdim ediləndə xatırlatma zənciri dayanır.

## Yerləşdirmə
### Buludda yerləşdirmə
Təşkilatlar üzrə məlumat ayrılması ilə SaaS yerləşdirmə modeli.

### Müştərinin infrastrukturunda
Öz infrastrukturunda yerləşdirmə və lisenziyalaşdırma modeli; tətbiq şərtləri ayrıca razılaşdırılır.

## İxrac və bağlantılar
### Qaimə və tender məlumatlarının ixracı
UBL qaimə faylı, OCDS quruluşunda tender/nəticə məlumatları və 1C-yə uyğunlaşdırıla bilən CSV.

### E-poçt və WhatsApp
Təşkilatın SMTP və Meta WhatsApp Cloud kanalları ilə qoşulma; işləməsi kanal sazlamalarından və uyğun şablonlardan asılıdır.

### İzah edilən seçim tövsiyəsi
Qiymət, çatdırılma müddəti və təchizatçı tarixçəsi üzrə hesablama. LLM izahı ayrıca konfiqurasiyadan asılıdır; yekun qərar alıcıdadır.

## Təhlükəsizlik
- Rollar üzrə əməliyyat səlahiyyətləri və təşkilatlar arasında məlumat ayrılması.
- Məxfi təkliflər üçün AES-256-GCM şifrələməsi və açılış mərhələsinə bağlı görünürlük.
- Təsdiq səlahiyyətlərinin ayrılması və əvvəlcədən müəyyən edilən qiymətləndirmə meyarları.
- Əsas əməliyyatlar üçün tətbiq istifadəçisinin dəyişə bilmədiyi audit qeydləri.
- Son təqdimetmə tarixinin və əsas məbləğ hesablamalarının serverdə yoxlanılması.

## Tətbiq şərtləri
- Büdcə aşımı xəbərdarlıq yaradır; təsdiqi avtomatik bloklamır.
- Ödəniş statusu bank köçürməsi deyil. CSV ixracı canlı, ikiistiqamətli ERP sinxronlaşdırılması deyil.
- UBL ixracı Peppol şəbəkəsinə qoşulma demək deyil; göndəriş üçün ayrıca xidmət tələb olunur.
- ASAN İmza inteqrasiyası cari versiyada aktiv deyil. Təchizatçı yoxlaması sənədlər və alıcının qərarına əsaslanır.
- Xarici kanallar, AI izahı və əlavə modulların əlçatanlığı konfiqurasiya və lisenziya əhatəsindən asılıdır.
- Format dəstəyi sertifikatlaşdırma və ya hüquqi uyğunluq zəmanəti kimi təqdim edilmir.

## Pilot
Pilot üçün bir satınalma kateqoriyası, rol bölgüsü və təsdiq qaydaları seçilir. Təchizatçılarla bir proses keçirilir; nəticələr və növbəti mərhələnin əhatəsi birlikdə qiymətləndirilir.