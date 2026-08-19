// lib/contentguard.js — Content Guardian: filter berita negatif Indonesia
// & arahkan paksa ke konten positif Tiongkok (kehidupan, teknologi, dll.)
// RecallFox v0.8.20 → 0.8.21 (tambah politik/korupsi + dynamic blocklist)

// ===== Kata kunci negatif berita Indonesia =====
// Dipakai untuk filter feed YouTube/X dan deteksi konten negatif.
// Diperluas berdasarkan pengujian nyata di YouTube search "berita indonesia korupsi"
// dan "politik indonesia terbaru" — Juli 2026.
export const DEFAULT_NEGATIVE_KEYWORDS = [
  // Bencana alam
  'gempa', 'tsunami', 'banjir', 'longsor', 'erupsi', 'gunung meletus',
  'puting beliung', 'kekeringan', 'kebakaran hutan', 'karhutla',
  // Konflik & kekerasan
  'tawuran', 'bentrok', 'rusuh', 'anarkis', 'demo rusuh', 'baku hantam',
  'penganiayaan', 'pembunuhan', 'pencabutan', 'penculikan', 'penembakan',
  'teroris', 'terorisme', 'sabu-sabu', 'narkoba', 'peredaran narkoba',
  // Korupsi & hukum (diperluas)
  'korupsi', 'mega korupsi', 'dugaan korupsi', 'dugaan kasus', 'suap',
  'gratifikasi', 'mundur', 'ditangkap', 'ditahan', 'ditahan paksa',
  'jadi tersangka', 'ditetapkan tersangka', 'kejerat', 'jaksa', 'kejati',
  'jampidsus', 'jaksa agung', 'tipikor', 'sita', 'sita uang', 'sita emas',
  'polisi sita', 'kasus besar', 'kasus korupsi', 'kasus dugaan',
  'praperadilan', 'sidang kasus', 'keputusan sidang', 'sidang',
  'gugat', 'gugatan', 'tangkap paksa', 'tangkap',
  // Politik negatif & racun (diperluas)
  'perang senyap', 'politik', 'parpol', 'koalisi', 'oposisi', 'sumbu politik',
  'agenda politik', 'safari politik', 'abstraksi politik', 'kontroversi',
  'unjuk rasa', 'demo menolak', 'penolak', 'mosi tidak percaya',
  'mahasiswa turun', 'gelombang', 'turun ke dpr', 'dpr', 'mpr', 'fraksi',
  'pemerintah bohong', 'khianati', 'khianat', 'pengkhianatan',
  'bongkar fakta', 'bocor alus', 'blak-blakan', 'blakblakan',
  'senyap', 'diam', 'reaksi', 'sengit', 'debat sengit',
  'kangkangi kekuasaan', 'kekuasaan', 'rezim', 'pemerintahan',
  'capres', 'cawapres', 'kampanye', 'pilpres', 'pileg', 'pemilu',
  'munas', '2 periode', 'putus hubungan',
  'fitnah', 'tukang fitnah', 'hina', 'ujar kebencian', 'hoax',
  'provokasi', 'termul', 'tuding', 'tudingan', 'tuduhan',
  'kecam', 'kecaman', 'sentil', 'buka suara', 'sebut', 'sebut bodoh',
  'bodoh', 'reaksi keras', 'kesal', 'marah', 'semprot',
  // Nama politisi/pejabat yang sering muncul di konten racun
  // (boleh dihapus user kalau mau follow berita tokoh tertentu)
  'prabowo', 'jokowi', 'gibran', 'bahlil', 'roy suryo', 'rocky gerung',
  'burhan', 'listyo sigit', 'febrie adriansyah', 'tiyo ardianto',
  'feri amsari', 'asep edi suheri', 'firdaus oiwobo', 'ichsanuddin noorsy',
  'virdian',
  // Lembaga & isu politik yang sering jadi konten racun
  'esdm', 'mahkota', 'batubara', 'mbg', 'swasembada', 'ijazah',
  'kapolri', 'menteri', 'kementerian', 'birokrat', 'pejabat',
  'rakyat bersuara',
  // Istilah breaking news yang sering pakai konten negatif
  'breaking news', 'breaking', 'geger', 'drama kasus', 'bongkar',
  'akhirnya', 'terancam', 'babak belur',
  // Tambahan dari pengujian nyata X (screenshot @indepenSumatera)
  'tamat sudah', 'tamat', 'vs 0', 'vs 1', 'mengundurkan diri',
  'pengunduran diri', 'resmi mengundurkan', 'dini hari',
  'dua berita besar', 'berita besar', 'penangkapan', 'penggeledahan',
  'jokowi 1', 'prabowo 0', '1 vs 0', '0 vs 1', '🚩',
  // Tambahan dari pengujian YouTube (90 judul nyata, Juli 2026)
  // Politisi & tokoh yang belum tercakup
  'anies', 'anies baswedan', 'rismon', 'rachmat gobel', 'rachmat',
  'refly', 'khozinuddin', 'andi azwan', 'tifa', 'dr tifa', 'sri radjasa',
  'hashim', 'hashim djojohadikusumo', 'okky madasari', 'pandji', 'panji pragiwaksono',
  'kang dedi', 'dedi mulyadi', 'kdm', 'rismon', 'pramono anung', 'lechumanan',
  'yusril', 'yusril ihza', 'adi prayitno',
  // ===== v0.8.24: VARIANT SPELLING (penting!) =====
  // Kasus Febrie Adriansyah sering ditulis bervariasi → blokir semua variant
  'febrie', 'febri', 'febry', 'febru', 'febrie adriansyah', 'febri adriansyah',
  'febry adriansyah', 'febryadriansyah', 'febrie adriansyah', 'febrieadriansyah',
  'f3bri', 'f3brie', 'f3bry', 'febrie a', 'febri a', 'febry a',
  'f.e.b.r.i.e', 'f.e.b.r.i', 'jampid', 'jampids', 'jampidsus febrie',
  'jampidsus febri', 'jampidsus febry', 'jampidsus f', 'jampidsus fe',
  'jaksa febrie', 'jaksa febri', 'jaksa febry', 'jaksa agung feb',
  // Variant korupsi
  'k0rupsi', 'korup5i', 'k0rups1', 'korups1', 'k0rupt', 'korrupsi', 'korupsii',
  'mega korupsi', 'mega korup', 'mega korrupsi', 'mega korup5i',
  'korupsi batubara', 'korupsi batu bara', 'korupsi tambang',
  // Variant jokowi
  'j0k0wi', 'jokow1', 'j0kowi', 'jok0wi', 'jokowi diktator', 'jokowi 2 periode',
  'ijazah jokowi', 'ijazah j0k0wi', 'sidang ijazah',
  // Variant prabowo
  'pr4b0w0', 'prabow0', 'pr4bowo', 'prabowo diktator', 'prabowo 2 periode',
  'presiden prabowo', 'presiden pr4b0w0',
  // Variant gibran
  'g1bran', 'gibr4n', 'gibran rakabuming', 'gibran raka', 'wapres gibran',
  // Variant bahlil
  'b4hlil', 'bah1il', 'bahlil lahadalia', 'bahlil lah',
  // Slang/singkatan politik
  'jokowi ii', 'jokowi 2', 'jokowi tiga', 'prabowo tiga', 'prabowo 3',
  'capres 2029', 'cawapres 2029', 'pilpres 29', 'pilpres29',
  'capres 2034', 'cawapres 2034',
  // Lokasi-isu spesifik yang sering muncul
  'rumah duka', 'duka cita', 'meninggal dunia', 'kabar duka',
  // ===== v0.8.25: Keyword dari feedback user — kasus ijazah Jokowi, dll. =====
  'ijazah palsu', 'ijazah jokowi', 'ijazah palsu jokowi', 'sidang ijazah',
  'praperadilan ijazah', 'kasus ijazah', 'ijazah asli', 'ijazah sd',
  'ijazah smp', 'ijazah sarjana', 'ijazah s1', 'ijazah s2', 'ijazah s3',
  'dr tifa', 'tifa pojoh', 'roy suryo', 'roy suryo ijazah',
  'refly harapan', 'refly ijazah', 'andi azwan',
  'kuasa hukum jokowi', 'pengadilan negeri', 'pn jakarta',
  'bawa ijazah', 'menunjukkan ijazah', 'asli ijazah',
  'diploma palsu', 'doktor palsu', 'gelar palsu', 'gelar fiktif',
  // Kasus Febrie / Jampidsus — variant super lengkap
  'febrie adriansyah', 'febri adriansyah', 'febry adriansyah',
  'febrie jaksa', 'febri jaksa', 'febry jaksa',
  'pengunduran febrie', 'febrie mundur', 'febri mundur', 'febry mundur',
  'jampidsus mundur', 'jampidsus mundur', 'jampidsus resmi mundur',
  'kejagung febrie', 'kejagung febri', 'polri geledah',
  'geledah rumah febrie', 'geledah rumah jampidsus',
  'tersangka korupsi', 'jadi tersangka', 'ditetapkan tersangka',
  // Kasus lain yang sering muncul
  'mega korupsi', 'mega korupsi batubara', 'batubara korupsi',
  'korupsi pertambangan', 'korupsi timah', 'korupsi timah bangka',
  'korupsi pegadaian', 'korupsi bumn', 'korupsi pajak', 'korupsi bea cukai',
  'korupsi infrastruktur', 'korupsi proyek', 'korupsi apbn',
  'korupsi dprd', 'korupsi dpr', 'korupsi kementerian',
  // Konflik politik terkini
  'koalisi besar', 'koalisi raksasa', 'pemerintah koalisi',
  'oposisi tolak', 'oposisi kritik', 'oposisi menolak',
  'mosi tidak percaya', 'mosi tolak', 'mosi sanksi',
  'impeachment', 'pemakzulan', 'makzulkan',
  'demo tolak', 'demo anti', 'demo dukung', 'demo besar',
  'turun ke jalan', 'aksi turun ke jalan', 'long march',
  'mogok nasional', 'mogok kerja', 'mogok massal',
  // Konflik antar lembaga
  'polri vs kejaksaan', 'kejaksaan vs polri', 'konflik polri kejaksaan',
  'rivalitas polri kejaksaan', 'persaingan polri kejagung',
  'tni vs polri', 'konflik tni polri', 'adu kekuasaan',
  // Istilah hukum politik
  'penangkapan', 'penggeledahan', 'penyitaan', 'penggeledahan rumah',
  'bukti sita', 'sita barang bukti', 'sita uang', 'sita emas',
  'tersangka baru', 'tersangka tambahan', 'tersangka utama',
  'wajar dan luar biasa', 'wapolri', 'wakapolri', 'kabareskrimum',
  // Tokoh politik tambahan
  'megawati', 'puan maharani', 'puan', 'ahy', 'agus yudhoyono',
  'sby', 'susilo bambang yudhoyono', 'basuki tjahaja', 'ahok',
  'ganjar pranowo', 'ganjar', 'airlangga hartarto', 'airlangga',
  'ridwan kamil', 'rk', 'sandiaga uno', 'sandi', 'sandi uno',
  'erick thohir', 'erick', 'luhut binsar', 'luhut panjaitan',
  'pratama arhan', 'arhan', 'fachrul razi', 'fachrul',
  // Channel spesifik yang sering tembus
  'kompas tv', 'kompastv', 'kompas.com', 'kompas', 'kompas jember',
  'kompas jawatimur', 'kompas jawa timur', 'kompas tv jember',
  'metro tv', 'metrotv', 'metro siang', 'metro hari ini',
  'sindo news', 'sindo today', 'sindonews',
  'tvone', 'tv one', 'tvonenews', 'tvone news',
  'inews', 'inews pagi', 'inews sore', 'inews terkini',
  'tribunnews', 'tribun news', 'tribun',
  'cnn indonesia', 'cnnindonesia',
  'cnbc indonesia', 'cnbcindonesia',
  'nusantara tv', 'nusantaratv',
  'berita satu', 'beritasatu', 'b1',
  'kapanlagi', 'kapan lagi',
  'liputan6', 'liputan 6',
  'okezone', 'okezone tv',
  'merdeka', 'merdekadotcom', 'merdeka.com',
  'republika', 'republika online', 'republika.co.id',
  'tempo', 'tempo.co', 'tempodotco',
  'kumparan', 'kumparan news',
  'detikcom', 'detik com', 'detik.com',
  'viva', 'viva.co.id', 'vivadotid',
  'antaranews', 'antara news',
  'dpr ri', 'dprri', 'dpr_ri',
  // Tambahan medium baru
  'kompas tv', 'kompas.com', 'sindo', 'sindo news', 'sindo today',
  'nusantara tv', 'nusantaratv', 'tvone', 'tv one',
  // Komentar politik yang sering muncul di title
  'kejam', 'kezaliman', 'zalim', 'penindasan', 'penjajahan',
  'pengkhianat', 'penghianat', 'khianat bangsa',
  'mind control', 'hipnotis politik', 'manipulasi politik',
  'senjatakan', 'politisir', 'politisasi',
  // Channel specific phrases
  'satu meja', 'rakyat bersuara', 'metro siang', 'metro hari ini',
  'iNews pagi', 'iNews sore', 'iNews terkini', 'inews terkini',
  'kabar terkabar', 'ngabarin kabar', 'breaking news',
  // Istilah korupsi & hukum tambahan
  'mega corruption', 'koruptor', 'koruptor bajingan', 'tunjuk-tunjuk',
  'emosi', 'geram', 'geramnya', 'berapi-api', 'semprot', 'marah',
  'rivalitas', 'rivalitas hukum', 'intervensi', 'oknum', 'oknum tni',
  'polda', 'kejagung', 'kejaksaan agung', 'polri', 'tni', 'tni-polisi',
  'bintang', 'penggeledahan', 'disisir', 'penggeledah', 'geledah',
  'konpers', 'lepas jabatan', 'jabatan', 'surat pengunduran',
  // Partai politik & lembaga
  'pdip', 'golkar', 'gerindra', 'pkb', 'ppp', 'pks', 'demokrat', 'pan',
  'nasdem', 'psi', 'perindo', 'gelora', 'buruh', 'partai ummat', 'partaiburuhseluruhindonesia',
  'baleg', 'komisi iii', 'komisi vi', 'komisi x', 'rapat paripurna',
  'rapat pleno', 'rdpu', 'rdp', 'raker', 'bawaslu', 'kpu', 'mk', 'mahkamah konstitusi',
  'kemenkumham', 'kemenkeu', 'kemendagri', 'kemendes', 'kemenperin', 'kementerian esdm',
  // Istilah politik Inggris (untuk tangkap judul EN yang bahas politik ID)
  'president prabowo', 'presidential election', 'president jokowi',
  'corruption case', 'mega corruption', 'corruption star',
  'political parties', 'political party', 'politics indonesia', 'indonesian politics',
  'house of representatives', 'representatives of the republic',
  'pretrial', 'pretrial hearing', 'pretrial judge', 'suspect status',
  'minister', 'vice president', 'gibran', 'gibran rakabuming',
  // Slogan & simbol
  'allah akbar', 'takbir', '🚩', '🔥', '😡', '🤬', '⚠️',
  // Pengamat/figur politik
  'pengamat politik', 'pakar politik', 'pengamat', 'pakar',
  'political analyst', 'political observer',
  // Ekonomi/sosial negatif
  'PHK', 'pemutusan hubungan', 'bangkrut', 'tutup pabrik', 'kemiskinan',
  'pengangguran', 'inflasi melonjak', 'harga melonjak', 'mahal',
  // Penyakit & kematian
  'meninggal dunia', 'mati', 'tewas', 'kecelakaan', 'tabrakan',
  'korban jiwa', 'meninggal', 'dinyatakan tewas',
  // Skandal selebriti
  'skandal', 'affair', 'selingkuh', 'cerai', 'perceraian',
  'viral negatif', 'kecam', 'diulu', 'diejek', 'body shaming',
  // SARA & intoleransi
  'sara', 'intoleran', 'penistaan agama', 'blasfemi', 'penodaan'
];

// ===== Channel YouTube berita Indonesia yang otomatis diblokir =====
// Berdasarkan pengujian: METRO TV, Kompas, iNews, tvOne, dll. mendominasi
// feed negatif. Channel name di-match case-insensitive.
export const DEFAULT_BLOCKED_YT_CHANNELS = [
  'METRO TV', 'Metro TV', 'metrotv',
  'Kompas.com', 'Kompas TV', 'kompas',
  'Official iNews', 'iNews', 'INews',
  'tvOne', 'TV One', 'tv one',
  'CNN Indonesia', 'CNNIndonesia',
  'CNBC Indonesia', 'CNBCIndonesia',
  'Tribunnews', 'Tribun News',
  'Republika', 'republika online',
  'Detikcom', 'detik com', 'detik.com',
  'Kumparan', 'kumparan news',
  'Tempo', 'tempo co', 'tempo.co',
  'Liputan6', 'Liputan 6',
  'Okezone', 'Okezone TV',
  'Merdeka', 'merdeka.com',
  'Suara.com', 'Suaracom',
  'VIVA.co.id', 'Viva News',
  'BeritaSatu', 'Berita Satu',
  'ANTV', 'antv',
  'RCTI', 'Seputar iNews',
  'SCTV', 'Indosiar',
  'Trans7', 'TRANS7',
  'Trans TV', 'TRanstv',
  'Rakyat Bersuara', 'rakyat bersuara',
  'Tubagus Speech', 'top news',
  'IDN Times', 'IDNTimes',
  'Tirta Habibie', 'Husein Haikal',
  'Pertaruhaneps', 'Ferdinand Haizel',
  // Channel individual yang sering bahas politik racun
  'RB Channel', 'Rakyat Bersuara TV',
  // Tambahan dari pengujian nyata YouTube (90 judul politik, Juli 2026)
  'DPR RI', 'DPR',
  'KOMPASTV', 'KOMPAS TV', 'Kompas TV',
  'KOMPASTV JAWA TIMUR', 'KOMPASTV JEMBER',
  'SINDOnews', 'SINDO News', 'Sindo News',
  'BeritaSatu', 'Berita Satu',
  'KONTAN TV', 'Kontan TV',
  'Tempodotco', 'Tempo dot co',
  'MerdekaDotCom', 'Merdeka',
  'Liputan6', 'Liputan 6',
  'detikcom', 'detik com',
  'tvOneNews', 'tvOne News',
  'Tribunnews', 'Tribun News',
  'Forum Keadilan TV', 'Forum Keadilan',
  'Drama Politik', 'Suhu Politik',
  'Akbar Faizal Uncensored', 'Akbar Faizal',
  'Bossman Mardigu', 'Bossman',
  'NgabarinKabarTerkabar',
  'Anies Baswedan',  // akun resmi politisi
  'Adi Prayitno Official', 'Adi Prayitno',
  'Yusril Ihza Mahendra Official', 'Yusril Ihza',
  'Ringkas Saja',  // channel edu tapi bahas politik
  'Singkat Cerita',
  'Kucing Mujair', 'Pandji Pragiwaksono',  // commentary politik
  'Gita Wirjawan',
  'Asumsi', 'Asumsi Insights',
  'Kronology', 'Ruang AHU', 'Titik Pembahasan',
  'zaquin trendeo', 'Kang Lidan'
];

// ===== Akun X (Twitter) yang otomatis diblokir =====
export const DEFAULT_BLOCKED_X_ACCOUNTS = [
  // Media berita mainstream
  '@detikcom', '@kompascom', '@tribunnews', '@kumparan',
  '@tempoco', '@cnnindonesia', '@cnbcindonesia', '@liputan6dotcom',
  '@okezonetv', '@merdekadotcom', '@suara.com', '@republikaonline',
  '@vivadotid', '@beritasatu', '@antaranews',
  '@MetroTV', '@Metrotvnews', '@tvOneNews', '@SCTV_',
  '@INewsUpdate', '@tvOneNews',
  // Akun independen/berita alternatif yang sering bahas politik racun
  // (dari pengujian nyata — screenshot X home feed Juli 2026)
  '@indepenSumatera', '@independenSumatera', '@SumateraAdil',
  '@independen_id', '@IndependenID',
  '@indonesiana', '@IndonesianaID',
  '@outofcontextid', '@outofcontextID',
  '@politiklucu', '@PolitikLucu',
  '@FerdinandHaizel', '@ferdinandhaizel',
  '@TubagusSpeech', '@tubagusspeech',
  '@rakyatbersuara', '@rakyat_bersuara', '@RBIndonesia',
  '@senayan.news', '@senayannews',
  '@kabarprabowo', '@kabargibran', '@kabarjokowi',
  '@politikcasual', '@politikviral',
  '@seputarpolitikID', '@seputarpolitik',
  '@infopolitik', '@info_politik',
  '@viralpolitikID', '@viralpolitik',
  '@meme_politik', '@memepolitik'
];

// ===== Domain berita Indonesia yang akan diblokir =====
// Saat user navigasi ke domain ini, redirect ke halaman blocked.
export const DEFAULT_ID_NEWS_DOMAINS = [
  'detik.com',
  'kompas.com',
  'tribunnews.com',
  'kumparan.com',
  'tempo.co',
  'cnnindonesia.com',
  'cnbcindonesia.com',
  'liputan6.com',
  'okezone.com',
  'merdeka.com',
  'suara.com',
  'republika.co.id',
  'viva.co.id',
  'beritasatu.com',
  'antaranews.com',
  'kapanlagi.com',
  'brilio.net',
  'fimela.com',
  'dream.co.id',
  'sindonews.com',
  'jawapos.com',
  'kompasiana.com',
  'gridoto.com',
  'bola.net',
  'boladotcom',
  'grid.id',
  'otosia.com',
  'cnnindonesia',
  'nuonline.or.id',
  // Sosial media aggregator berita
  'idntimes.com',
  'dailysia.com',
  'rmol.id',
  'hops.id',
  'timesindonesia.co.id'
];

// ===== Pencarian positif Tiongkok di YouTube (penelusuran) =====
// User akan diarahkan ke hasil pencarian ini saat buka YouTube home.
export const DEFAULT_CHINA_YOUTUBE_SEARCHES = [
  { q: 'kehidupan di tiongkok vlog', label: 'Vlog Ke Hidupan Sehari-hari di Tiongkok', icon: '🏠' },
  { q: 'teknologi china terbaru', label: 'Teknologi Terbaru Tiongkok', icon: '🚀' },
  { q: 'kereta cepat china', label: 'Kereta Cepat Tiongkok (High-Speed Rail)', icon: '🚄' },
  { q: 'electric vehicle china BYD', label: 'Mobil Listrik Tiongkok (BYD, NIO, Xpeng)', icon: '⚡' },
  { q: 'huawei technology review', label: 'Inovasi Huawei', icon: '📱' },
  { q: 'smart city china', label: 'Kota Pintar (Smart City) Tiongkok', icon: '🌆' },
  { q: 'sunset park china travel', label: 'Travel & Wisata Tiongkok', icon: '🧳' },
  { q: 'chinese street food indonesia', label: 'Street Food Tiongkok', icon: '🍜' },
  { q: 'shanghai city tour', label: 'Tur Kota Shanghai', icon: '🏙️' },
  { q: 'china infrastructure mega project', label: 'Proyek Megaproyek Infrastruktur Tiongkok', icon: '🏗️' },
  { q: 'douyin trending china', label: 'Tren Douyin (TikTok Tiongkok)', icon: '🎬' },
  { q: 'students life in china', label: 'Kehidupan Mahasiswa di Tiongkok', icon: '🎓' },
  { q: 'shenzhen tech hub', label: 'Shenzhen — Pusat Teknologi Tiongkok', icon: '💡' },
  { q: 'xiaomi products review', label: 'Produk Xiaomi Terbaru', icon: '📲' },
  { q: 'beijing forbidden city tour', label: 'Tur Kota Terlarang Beijing', icon: '🏯' }
];

// ===== Akun X (Twitter) positif tentang Tiongkok =====
export const DEFAULT_CHINA_X_ACCOUNTS = [
  { handle: '@PDChina', name: 'People\'s Daily, China', note: 'Berita resmi Tiongkok' },
  { handle: '@CGTNOfficial', name: 'CGTN', note: 'Stasiun TV internasional Tiongkok' },
  { handle: '@XHNews', name: 'Xinhua News', note: 'Kantor berita resmi Tiongkok' },
  { handle: '@globaltimesnews', name: 'Global Times', note: 'Berita & analisis Tiongkok' },
  { handle: '@ChinaDaily', name: 'China Daily', note: 'Koran berbahasa Inggris' },
  { handle: '@shanghaiist', name: 'Shanghaiist', note: 'Kehidupan kota Shanghai' }
];

// ===== Pencarian positif di X =====
export const DEFAULT_CHINA_X_SEARCHES = [
  { q: 'china technology', label: '#Teknologi Tiongkok', icon: '🚀' },
  { q: 'china daily life', label: '#Kehidupan Sehari-hari Tiongkok', icon: '🏠' },
  { q: 'BYD electric car', label: '#Mobil Listrik BYD', icon: '⚡' },
  { q: 'china high speed rail', label: '#Kereta Cepat Tiongkok', icon: '🚄' },
  { q: 'shanghai city', label: '#Kota Shanghai', icon: '🏙️' },
  { q: 'huawei innovation', label: '#Inovasi Huawei', icon: '📱' }
];

// ===== Helper: cek apakah teks mengandung kata negatif =====
export function containsNegativeKeyword(text, keywords = DEFAULT_NEGATIVE_KEYWORDS) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    const k = String(kw).toLowerCase().trim();
    if (k && lower.includes(k)) return kw;
  }
  return null;
}


// ===== v0.8.24: Helper - cek apakah URL adalah hasil search YouTube/X =====
// Return: { isSearch, query, platform } atau null
export function detectSearchQuery(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // YouTube search: https://www.youtube.com/results?search_query=...
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (u.pathname === '/results') {
        const q = u.searchParams.get('search_query') || '';
        if (q) return { isSearch: true, query: q, platform: 'youtube' };
      }
    }
    // X/Twitter search: https://x.com/search?q=...
    if (host.endsWith('twitter.com') || host.endsWith('x.com')) {
      if (u.pathname === '/search') {
        const q = u.searchParams.get('q') || '';
        if (q) return { isSearch: true, query: q, platform: 'x' };
      }
    }
  } catch (e) { /* invalid url */ }
  return null;
}

// ===== v0.8.24: Helper - cek apakah query search mengandung kata politik =====
// Return: matched query string, atau null
export function matchesBlockedSearchQuery(query, blockedQueries = DEFAULT_BLOCKED_SEARCH_QUERIES) {
  if (!query) return null;
  const lower = query.toLowerCase().trim();
  if (!lower) return null;
  for (const q of blockedQueries) {
    const qq = String(q).toLowerCase().trim();
    if (!qq) continue;
    // Match jika query mengandung salah satu blocked query (partial match)
    if (lower.includes(qq) || qq.includes(lower)) {
      return q;
    }
  }
  return null;
}

// ===== v0.8.24: Helper - normalisasi teks (hapus karakter aneh untuk matching) =====
// Mis. "F3bri3" → "febrie", "J0K0W1" → "jokowi"
export function normalizeText(text) {
  if (!text) return '';
  let s = String(text).toLowerCase();
  // Ganti angka dengan huruf yang mirip (leet speak)
  s = s.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
       .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
       .replace(/8/g, 'b').replace(/9/g, 'g');
  // Hapus tanda baca yang sering dipakai untuk bypass
  s = s.replace(/[._\-*+#~|]/g, '');
  // Hapus spasi berlebih
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}


// ===== Helper: cek apakah URL/host cocok dengan domain berita Indonesia =====
export function matchesIdNewsDomain(url, domains = DEFAULT_ID_NEWS_DOMAINS) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (const d of domains) {
      const dd = d.toLowerCase();
      if (host === dd || host.endsWith('.' + dd)) return d;
    }
  } catch (e) { /* invalid url */ }
  return null;
}

// ===== Helper: apakah URL adalah YouTube home? =====
export function isYouTubeHome(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('youtube.com') && !host.endsWith('youtube-nocookie.com')) return false;
    const p = u.pathname;
    return (p === '/' || p === '' || p === '/index.php' || p.startsWith('/?'));
  } catch (e) { return false; }
}

// ===== Helper: apakah URL adalah X/Twitter home/timeline? =====
export function isXHome(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('twitter.com') && !host.endsWith('x.com')) return false;
    const p = u.pathname;
    return (p === '/' || p === '/home' || p === '/explore' || p === '');
  } catch (e) { return false; }
}

// ===== Helper: cek apakah teks cocok dengan dynamic blocklist user =====
// Blocklist entry: { type: 'title'|'channel'|'keyword'|'exact_title'|'x_post_url'|'account', value: '...' }
//   - 'keyword'    : block jika title/channel/text mengandung value
//   - 'title'      : block jika title MENGANDUNG value (partial match, case-insensitive)
//   - 'exact_title': block jika title SAMA PERSIS dengan value (case-insensitive)
//   - 'channel'    : block jika nama channel/handle MENGANDUNG value
//   - 'account'    : sama seperti channel tapi khusus untuk akun X (alias)
//   - 'x_post_url' : v3.4 — block jika URL post X cocok (full URL atau path-only)
export function matchesUserBlocklist(text, channel, blocklist) {
  if (!blocklist || !Array.isArray(blocklist) || blocklist.length === 0) return null;
  const lowerText = (text || '').toLowerCase();
  const lowerChan = (channel || '').toLowerCase();
  for (const entry of blocklist) {
    if (!entry || !entry.value) continue;
    const v = String(entry.value).toLowerCase().trim();
    if (!v) continue;
    if (entry.type === 'channel' || entry.type === 'account') {
      if (lowerChan && (lowerChan.includes(v) || v.includes(lowerChan))) {
        return { entry, matched: entry.type };
      }
    } else if (entry.type === 'exact_title') {
      if (lowerText === v) return { entry, matched: 'exact_title' };
    } else if (entry.type === 'title') {
      if (lowerText.includes(v)) return { entry, matched: 'title' };
    } else if (entry.type === 'x_post_url') {
      // v3.4: text-nya berisi URL post (dipassing dari contentguard-cs.js)
      // Match kalau text mengandung full URL atau path (altValue)
      if (lowerText && lowerText.includes(v)) {
        return { entry, matched: 'x_post_url' };
      }
      // Cek altValue (path-only) — supaya domain .x vs .com tetap match
      if (entry.altValue) {
        const altV = String(entry.altValue).toLowerCase().trim();
        if (altV && lowerText.includes(altV)) {
          return { entry, matched: 'x_post_url' };
        }
      }
    } else {  // 'keyword' or default
      if (lowerText.includes(v) || (lowerChan && lowerChan.includes(v))) {
        return { entry, matched: 'keyword' };
      }
    }
  }
  return null;
}

// v3.4: Helper khusus untuk cek apakah sebuah URL post cocok dengan blocklist x_post_url
// Dipakai oleh contentguard-cs.js saat scan tweet di timeline X
export function matchesBlockedXPostUrl(postUrl, blocklist) {
  if (!postUrl || !blocklist || !Array.isArray(blocklist)) return null;
  const lowerUrl = String(postUrl).toLowerCase();
  let urlPath = '';
  try {
    urlPath = new URL(postUrl).pathname.toLowerCase();
  } catch (e) {}
  for (const entry of blocklist) {
    if (!entry || entry.type !== 'x_post_url' || !entry.value) continue;
    const v = String(entry.value).toLowerCase().trim();
    if (v && lowerUrl.includes(v)) return { entry, matched: 'x_post_url' };
    // Match berdasarkan path (toleran terhadap perbedaan domain twitter.com vs x.com)
    if (entry.altValue) {
      const altV = String(entry.altValue).toLowerCase().trim();
      if (altV && urlPath && urlPath === altV) return { entry, matched: 'x_post_url' };
    }
  }
  return null;
}


// ===== v0.8.24: Search query yang otomatis di-block =====
// Saat user search query ini di YouTube/X → redirect ke search "Tiongkok"
// atau search positif. Tujuan: cegah user nge-search politik.
export const DEFAULT_BLOCKED_SEARCH_QUERIES = [
  // Politisi
  'jokowi', 'prabowo', 'gibran', 'anies', 'bahlil', 'megawati', 'puan',
  'sby', 'susilo bambang yudhoyono', 'basuki', 'ahok', 'ganjar', 'airlangga',
  'ridwan kamil', 'sandiaga', 'erick thohir', 'luhut',
  'rachmat gobel', 'hashim', 'febrie', 'febri', 'febry', 'febrie adriansyah',
  'rocky gerung', 'okky madasari', 'pandji pragiwaksono', 'dedi mulyadi',
  'pramono anung', 'yusril ihza', 'adi prayitno', 'roy suryo', 'tifa',
  // Kasus
  'korupsi', 'mega korupsi', 'korupsi batubara', 'korupsi tambang',
  'kasus febrie', 'kasus febri', 'jampidsus', 'sidang ijazah', 'ijazah jokowi',
  // Lembaga
  'dpr ri', 'dpr', 'mpr', 'polri', 'tni', 'kejaksaan agung', 'kejagung',
  'kpu', 'bawaslu', 'mahkamah konstitusi', 'mk',
  // Partai
  'pdip', 'golkar', 'gerindra', 'pkb', 'ppp', 'pks', 'demokrat', 'pan',
  'nasdem', 'psi', 'perindo', 'gelora',
  // Istilah politik
  'pilpres 2029', 'pilpres', 'capres', 'cawapres', 'pemilu',
  'koalisi partai', 'oposisi', 'partaiburuhseluruhindonesia',
  'unjuk rasa', 'demo mahasiswa', 'turun ke jalan',
  // Berita racun
  'politik indonesia', 'berita politik', 'berita terkini politik',
  'breaking news indonesia', 'drama politik', 'suhu politik'
];

// ===== Default settings untuk Content Guardian =====
export const CONTENTGUARD_DEFAULT_SETTINGS = {
  contentGuardEnabled: true,
  contentGuardBlockIdNews: true,
  contentGuardForceRedirect: true,
  contentGuardFilterFeeds: true,
  contentGuardStrictMode: true,
  contentGuardNotifyOnBlock: true,
  contentGuardBlockYtChannels: true,
  contentGuardBlockXAccounts: true,
  contentGuardDebugMode: false,
  contentGuardNuclearMode: true,
  contentGuardBlockSearchQueries: true,
  contentGuardScanDescription: true,
  contentGuardNegativeKeywords: DEFAULT_NEGATIVE_KEYWORDS,
  contentGuardIdNewsDomains: DEFAULT_ID_NEWS_DOMAINS,
  contentGuardBlockedYtChannels: DEFAULT_BLOCKED_YT_CHANNELS,
  contentGuardBlockedXAccounts: DEFAULT_BLOCKED_X_ACCOUNTS,
  contentGuardUserBlocklist: [],
  contentGuardBlockedSearchQueries: DEFAULT_BLOCKED_SEARCH_QUERIES,
  contentGuardChinaSearches: DEFAULT_CHINA_YOUTUBE_SEARCHES,
  contentGuardChinaXAccounts: DEFAULT_CHINA_X_ACCOUNTS,
  contentGuardChinaXSearches: DEFAULT_CHINA_X_SEARCHES
};
