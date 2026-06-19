// Static IATA airport code → city/airport display name
// Major airports worldwide; falls back to raw code if not found.
const AIRPORTS = {
  // Australia & Pacific
  SYD: "Sydney", MEL: "Melbourne", BNE: "Brisbane", PER: "Perth",
  ADL: "Adelaide", CBR: "Canberra", HBA: "Hobart", DRW: "Darwin",
  CNS: "Cairns", OOL: "Gold Coast", TSV: "Townsville", MKY: "Mackay",
  HTI: "Hamilton Island", AVV: "Melbourne Avalon", ASP: "Alice Springs",
  AKL: "Auckland", CHC: "Christchurch", WLG: "Wellington", ZQN: "Queenstown",
  DUD: "Dunedin", NPE: "Napier", NSN: "Nelson", PMR: "Palmerston North",
  PPT: "Papeete", NAN: "Nadi", APW: "Apia", TBU: "Nukuʻalofa",
  HIR: "Honiara", SUV: "Suva", POM: "Port Moresby",

  // Southeast Asia
  SIN: "Singapore", KUL: "Kuala Lumpur", BKK: "Bangkok Suvarnabhumi",
  DMK: "Bangkok Don Mueang", CGK: "Jakarta", SUB: "Surabaya",
  DPS: "Bali", MNL: "Manila", CEB: "Cebu", HAN: "Hanoi",
  SGN: "Ho Chi Minh City", DAD: "Da Nang", PQC: "Phu Quoc",
  REP: "Siem Reap", PNH: "Phnom Penh", VTE: "Vientiane",
  RGN: "Yangon", MDL: "Mandalay", BWN: "Bandar Seri Begawan",
  USM: "Koh Samui", HKT: "Phuket", CNX: "Chiang Mai",

  // East Asia
  NRT: "Tokyo Narita", HND: "Tokyo Haneda", KIX: "Osaka Kansai",
  ITM: "Osaka Itami", CTS: "Sapporo", FUK: "Fukuoka", OKA: "Okinawa",
  NGO: "Nagoya", HIJ: "Hiroshima", KMI: "Miyazaki",
  ICN: "Seoul Incheon", GMP: "Seoul Gimpo", PUS: "Busan", CJU: "Jeju",
  PEK: "Beijing Capital", PKX: "Beijing Daxing", PVG: "Shanghai Pudong",
  SHA: "Shanghai Hongqiao", CAN: "Guangzhou", SZX: "Shenzhen",
  CTU: "Chengdu", WUH: "Wuhan", HGH: "Hangzhou", XIY: "Xi'an",
  KMG: "Kunming", CKG: "Chongqing", NKG: "Nanjing", TSN: "Tianjin",
  DLC: "Dalian", HAK: "Haikou", SHE: "Shenyang", TAO: "Qingdao",
  CSX: "Changsha", CGO: "Zhengzhou", HFE: "Hefei", TNA: "Jinan",
  TPE: "Taipei Taoyuan", TSA: "Taipei Songshan", KHH: "Kaohsiung",
  HKG: "Hong Kong", MFM: "Macau",

  // South Asia
  BOM: "Mumbai", DEL: "Delhi", BLR: "Bangalore", MAA: "Chennai",
  HYD: "Hyderabad", CCU: "Kolkata", COK: "Kochi", PNQ: "Pune",
  AMD: "Ahmedabad", GOI: "Goa", IXC: "Chandigarh", JAI: "Jaipur",
  LKO: "Lucknow", PAT: "Patna", IDR: "Indore", BBI: "Bhubaneswar",
  CMB: "Colombo", MLE: "Malé", KTM: "Kathmandu", DAC: "Dhaka",
  KHI: "Karachi", LHE: "Lahore", ISB: "Islamabad",
  RGN2: "Yangon",

  // Middle East
  DXB: "Dubai", AUH: "Abu Dhabi", SHJ: "Sharjah", DWC: "Dubai Al Maktoum",
  DOH: "Doha", BAH: "Bahrain", MCT: "Muscat", KWI: "Kuwait City",
  RUH: "Riyadh", JED: "Jeddah", MED: "Medina", DMM: "Dammam",
  AMM: "Amman", BEY: "Beirut", TLV: "Tel Aviv", CAI: "Cairo",
  ALY: "Alexandria", IST: "Istanbul", SAW: "Istanbul Sabiha",
  ADB: "Izmir", ESB: "Ankara", AYT: "Antalya", DLM: "Dalaman",
  BGW: "Baghdad", IKA: "Tehran",

  // Europe — UK & Ireland
  LHR: "London Heathrow", LGW: "London Gatwick", LTN: "London Luton",
  STN: "London Stansted", LCY: "London City", MAN: "Manchester",
  EDI: "Edinburgh", GLA: "Glasgow", BHX: "Birmingham", BRS: "Bristol",
  NCL: "Newcastle", LPL: "Liverpool", EMA: "East Midlands",
  LBA: "Leeds Bradford", ABZ: "Aberdeen", INV: "Inverness",
  BFS: "Belfast International", BHD: "Belfast City",
  DUB: "Dublin", ORK: "Cork", SNN: "Shannon",

  // Europe — France
  CDG: "Paris Charles de Gaulle", ORY: "Paris Orly", NCE: "Nice",
  LYS: "Lyon", MRS: "Marseille", TLS: "Toulouse", NTE: "Nantes",
  BOD: "Bordeaux", LIL: "Lille", SXB: "Strasbourg", MPL: "Montpellier",

  // Europe — Germany
  FRA: "Frankfurt", MUC: "Munich", DUS: "Düsseldorf", BER: "Berlin",
  HAM: "Hamburg", CGN: "Cologne", STR: "Stuttgart", NUE: "Nuremberg",
  HAJ: "Hanover", BRE: "Bremen", LEJ: "Leipzig", DRS: "Dresden",

  // Europe — Benelux
  AMS: "Amsterdam", RTM: "Rotterdam", EIN: "Eindhoven",
  BRU: "Brussels", CRL: "Brussels Charleroi",
  LUX: "Luxembourg",

  // Europe — Iberia
  MAD: "Madrid", BCN: "Barcelona", PMI: "Palma de Mallorca",
  AGP: "Málaga", VLC: "Valencia", SVQ: "Seville", TFS: "Tenerife South",
  LPA: "Gran Canaria", ACE: "Lanzarote", FUE: "Fuerteventura",
  BIO: "Bilbao", SDR: "Santander", ALC: "Alicante", IBZ: "Ibiza",
  MAH: "Menorca", ZAZ: "Zaragoza",
  LIS: "Lisbon", OPO: "Porto", FAO: "Faro", PDL: "Ponta Delgada",
  FNC: "Funchal",

  // Europe — Italy
  FCO: "Rome Fiumicino", CIA: "Rome Ciampino", MXP: "Milan Malpensa",
  LIN: "Milan Linate", BGY: "Milan Bergamo", VCE: "Venice",
  NAP: "Naples", BLQ: "Bologna", PMO: "Palermo", CTA: "Catania",
  PSA: "Pisa", FLR: "Florence", TRN: "Turin", BRI: "Bari", BDS: "Brindisi",
  VRN: "Verona", TSF: "Treviso",

  // Europe — Scandinavia
  OSL: "Oslo", BGO: "Bergen", TRD: "Trondheim", SVG: "Stavanger",
  BOO: "Bodø", TOS: "Tromsø",
  CPH: "Copenhagen", BLL: "Billund", AAL: "Aalborg",
  ARN: "Stockholm Arlanda", BMA: "Stockholm Bromma", GOT: "Gothenburg",
  MMX: "Malmö", LLA: "Luleå", UME: "Umeå", VBY: "Visby",
  HEL: "Helsinki", TMP: "Tampere", TKU: "Turku", OUL: "Oulu",
  RVN: "Rovaniemi", IVL: "Ivalo",
  KEF: "Reykjavik",

  // Europe — Central & Eastern
  VIE: "Vienna", SZG: "Salzburg", GRZ: "Graz", INN: "Innsbruck",
  ZRH: "Zurich", GVA: "Geneva", BSL: "Basel",
  WAW: "Warsaw", KRK: "Kraków", GDN: "Gdańsk", WRO: "Wrocław",
  POZ: "Poznań", KTW: "Katowice", RZE: "Rzeszów",
  PRG: "Prague", BRQ: "Brno",
  BUD: "Budapest",
  OTP: "Bucharest", CLJ: "Cluj-Napoca", TSR: "Timișoara",
  SOF: "Sofia", VAR: "Varna", BOJ: "Burgas",
  SKP: "Skopje", TIA: "Tirana", LJU: "Ljubljana",
  ZAG: "Zagreb", SPU: "Split", DBV: "Dubrovnik", ZAD: "Zadar",
  BEG: "Belgrade", TGD: "Podgorica", PRN: "Pristina",
  SJJ: "Sarajevo", TZL: "Tuzla",
  ATH: "Athens", SKG: "Thessaloniki", HER: "Heraklion", RHO: "Rhodes",
  CFU: "Corfu", MJT: "Mytilene",
  MSQ: "Minsk", KIV: "Chișinău",
  KBP: "Kyiv Boryspil", IEV: "Kyiv Zhuliany", LWO: "Lviv",
  ODS: "Odessa", HRK: "Kharkiv", DNK: "Dnipro",
  RIX: "Riga", TLL: "Tallinn", VNO: "Vilnius",
  LED: "St. Petersburg", SVX: "Yekaterinburg", OVB: "Novosibirsk",
  SVO: "Moscow Sheremetyevo", DME: "Moscow Domodedovo", VKO: "Moscow Vnukovo",

  // North America — USA
  ATL: "Atlanta", LAX: "Los Angeles", ORD: "Chicago O'Hare",
  DFW: "Dallas/Fort Worth", DEN: "Denver", JFK: "New York JFK",
  SFO: "San Francisco", LAS: "Las Vegas", SEA: "Seattle",
  CLT: "Charlotte", MIA: "Miami", PHX: "Phoenix", EWR: "Newark",
  MSP: "Minneapolis", DTW: "Detroit", BOS: "Boston", FLL: "Fort Lauderdale",
  MCO: "Orlando", IAH: "Houston Intercontinental", BWI: "Baltimore",
  MDW: "Chicago Midway", LGA: "New York LaGuardia", TPA: "Tampa",
  SAN: "San Diego", DCA: "Washington Reagan", IAD: "Washington Dulles",
  MKE: "Milwaukee", MSY: "New Orleans", STL: "St. Louis",
  RDU: "Raleigh-Durham", HOU: "Houston Hobby", PDX: "Portland",
  CLE: "Cleveland", SMF: "Sacramento", SNA: "Orange County",
  OAK: "Oakland", SJC: "San Jose", BNA: "Nashville", AUS: "Austin",
  RSW: "Fort Myers", PIT: "Pittsburgh", IND: "Indianapolis",
  CMH: "Columbus", BDL: "Hartford", OMA: "Omaha", RIC: "Richmond",
  JAX: "Jacksonville", SAV: "Savannah", CHS: "Charleston",
  PBI: "West Palm Beach", MEM: "Memphis", BUF: "Buffalo",
  ROC: "Rochester", SYR: "Syracuse", ALB: "Albany",
  ORF: "Norfolk", GSO: "Greensboro", MHT: "Manchester NH",
  PWM: "Portland ME", BTV: "Burlington", BGR: "Bangor",
  ABQ: "Albuquerque", ELP: "El Paso", SAT: "San Antonio",
  OKC: "Oklahoma City", TUL: "Tulsa", MCI: "Kansas City",
  DSM: "Des Moines", MSN: "Madison", GRR: "Grand Rapids",
  SLC: "Salt Lake City", TUS: "Tucson", BOI: "Boise",
  RNO: "Reno", LGB: "Long Beach", BUR: "Burbank", ONT: "Ontario",
  PSP: "Palm Springs", SBA: "Santa Barbara", MRY: "Monterey",
  SFB: "Sanford", PIE: "St. Pete-Clearwater", SRQ: "Sarasota",
  PNS: "Pensacola", VPS: "Fort Walton Beach", MOB: "Mobile",
  BHM: "Birmingham AL", HSV: "Huntsville", LIT: "Little Rock",
  TYS: "Knoxville", CHA: "Chattanooga", GSP: "Greenville-Spartanburg",
  AVL: "Asheville", ILM: "Wilmington NC", FAY: "Fayetteville",
  HNL: "Honolulu", OGG: "Maui", KOA: "Kona", LIH: "Lihue",
  ANC: "Anchorage", FAI: "Fairbanks", JNU: "Juneau",

  // North America — Canada
  YYZ: "Toronto", YVR: "Vancouver", YUL: "Montreal", YYC: "Calgary",
  YEG: "Edmonton", YOW: "Ottawa", YHZ: "Halifax", YWG: "Winnipeg",
  YQB: "Quebec City", YYJ: "Victoria", YXE: "Saskatoon",
  YQR: "Regina", YQT: "Thunder Bay", YLW: "Kelowna",
  YXS: "Prince George", YZF: "Yellowknife",

  // Mexico & Central America
  MEX: "Mexico City", GDL: "Guadalajara", MTY: "Monterrey",
  CUN: "Cancún", SJD: "Los Cabos", PVR: "Puerto Vallarta",
  BJX: "León/Guanajuato", MID: "Mérida", OAX: "Oaxaca",
  HUX: "Huatulco", ZIH: "Zihuatanejo", VSA: "Villahermosa",
  GUA: "Guatemala City", SAL: "San Salvador", TGU: "Tegucigalpa",
  MGA: "Managua", SJO: "San José", PTY: "Panama City",
  BZE: "Belize City",

  // Caribbean
  MBJ: "Montego Bay", KIN: "Kingston", NAS: "Nassau",
  BDA: "Bermuda", PLS: "Providenciales", POP: "Puerto Plata",
  SDQ: "Santo Domingo", STI: "Santiago DR", SJU: "San Juan",
  STT: "St. Thomas", STX: "St. Croix", SXM: "St. Maarten",
  CUR: "Curaçao", BON: "Bonaire", AUA: "Aruba",
  BGI: "Barbados", GEO: "Georgetown", POS: "Port of Spain",
  TAB: "Tobago", SLU: "St. Lucia", SKB: "St. Kitts",
  ANU: "Antigua", EIS: "Tortola", VIJ: "Virgin Gorda",

  // South America
  GRU: "São Paulo Guarulhos", CGH: "São Paulo Congonhas",
  VCP: "Campinas", GIG: "Rio de Janeiro", SDU: "Rio de Janeiro Santos Dumont",
  BSB: "Brasília", SSA: "Salvador", FOR: "Fortaleza",
  POA: "Porto Alegre", REC: "Recife", MAO: "Manaus",
  BEL: "Belém", FLN: "Florianópolis", CWB: "Curitiba",
  CNF: "Belo Horizonte", MCZ: "Maceió", NAT: "Natal",
  EZE: "Buenos Aires Ezeiza", AEP: "Buenos Aires Aeroparque",
  COR: "Córdoba", MDZ: "Mendoza", IGR: "Iguazú",
  SCL: "Santiago", PMC: "Puerto Montt", IPC: "Easter Island",
  LIM: "Lima", CUZ: "Cusco", AQP: "Arequipa",
  BOG: "Bogotá", MDE: "Medellín", CTG: "Cartagena",
  CLO: "Cali", BAQ: "Barranquilla",
  UIO: "Quito", GYE: "Guayaquil", GPS: "Galápagos",
  ASU: "Asunción", MVD: "Montevideo",
  LPB: "La Paz", VVI: "Santa Cruz", CBB: "Cochabamba",
  CCS: "Caracas", PMV: "Margarita Island",

  // Africa
  JNB: "Johannesburg", CPT: "Cape Town", DUR: "Durban",
  PLZ: "Port Elizabeth", ELS: "East London", GRJ: "George",
  NBO: "Nairobi", MBA: "Mombasa", ADD: "Addis Ababa",
  LOS: "Lagos", ABV: "Abuja", ACC: "Accra", DKR: "Dakar",
  CMN: "Casablanca", RAK: "Marrakech", AGA: "Agadir", FEZ: "Fez",
  TNG: "Tangier", ALG: "Algiers", ORN: "Oran", TUN: "Tunis",
  LXR: "Luxor", HRG: "Hurghada", SSH: "Sharm el-Sheikh",
  KRT: "Khartoum", HRE: "Harare", LUN: "Lusaka", MRU: "Mauritius",
  TNR: "Antananarivo", SEZ: "Seychelles", RUN: "Réunion",
  DAR: "Dar es Salaam", JRO: "Kilimanjaro", ZNZ: "Zanzibar",
  EBB: "Entebbe", KGL: "Kigali", BJM: "Bujumbura",
  FIH: "Kinshasa", BZV: "Brazzaville", DLA: "Douala",
  LFW: "Lomé", COO: "Cotonou", ABJ: "Abidjan", CKY: "Conakry",
  FNA: "Freetown", ROB: "Monrovia",
}

/**
 * Returns a human-readable label for an airport IATA code.
 * Falls back to the raw code if not in the table.
 */
export function airportName(iata) {
  if (!iata) return ''
  return AIRPORTS[iata.toUpperCase()] || iata
}

/**
 * Returns "City (IATA)" if the city is known, otherwise just "IATA".
 */
export function airportLabel(iata) {
  if (!iata) return ''
  const code = iata.toUpperCase()
  const name = AIRPORTS[code]
  return name ? `${name} (${code})` : code
}
