// ============================================================
// LONGHAUL — Ship names
//
// Every hull in the system has a name, and a world of thousands of ships
// should almost never meet the same one twice. A name is a pattern
// ("{adj} {noun}", "{ofHead} of {place}", "{given}'s {thing}") filled from
// word lists, and which lists depends on who flies the ship and what for:
//   culture — Earth and Luna name ships the way corporations and
//     sentimental owners do ("Kepler Bright", "Lagos Promise", "Mabel's
//     Folly"). Mars is earnest, frontier and terraforming ("Second
//     Spring", "Daughter of Hellas"). The Belt names in Lang Belta and
//     Belter humour ("Beratna Pampa", "Ke Rock Tu"). Independents borrow
//     from everyone and add trader's gallows humour ("Fourth Mortgage").
//   trade — prospectors, couriers, shuttles, freighters, ice haulers,
//     tankers, liners and mining ships each add their own vocabulary
//     (ore and luck, speed, plodding work, ice, volatiles, rock-chewing).
//   sub-faction — a corporation's big hulls carry its code some of the
//     time (LKC, HAD, GAC, BSS). Pur'n'Kleen's water haulers are
//     whimsical. Ganymede farms, the Vesta cooperative, the Belt unions,
//     Tycho and the Ceres militants each have their words, and every
//     pirate clan names its hulls to its own legend.
//   service — navies prefix their hulls (UNN, MCRN; OPA warships carry
//     bare Belter names). Police carry their service's short code (UNS,
//     MSS, SH) and often a number. Pirates never announce themselves.
//
// Variety is a budget. A pattern drawn often from a small space repeats
// itself: two hundred fixed phrases given to 1% of 20,000 ships repeat
// about seventy times. So each pattern's weight is held to what its space
// can bear: three-word compositions ("Lucky Strike of Gaspra", "Old
// Halvorsen's Pick", "Child of Second Spring") carry most names, two-word
// ones ("Lusaka Finder", "Sabaka Dust") a good share, and the small spaces
// (fixed phrases, famous names) only season them. nameEntropy() reports
// each pool's raw size and its effective size (one over the chance that
// two draws collide); tests/names.test.mjs prints the duplicate rate over
// 200,000 names, and the size of a real game's.
//
// Variety makes a clash rare; the registry makes it impossible. Each game
// state has a runtime-only set of every name handed out: a WeakMap keyed
// by the state object, so it never reaches a save. It is built on first
// use from the state's entities and our own ship, so a loaded game is
// covered. A name is never released, and a wreck keeps its name (with
// " (wreck)" after it). On a clash the generator rolls again a few times,
// then numbers the name in its own style: "Ceres Dawn II", "UNN Ravi
// (FFG-214)", "SH Vigilant 31".
//
// This module takes a class's fields (kind, category, names) rather than
// importing the catalog, because ship-classes.js imports it.
// ============================================================

import { random, pick, chance, randInt } from '../core/rng.js';

/** A word list from a comma-separated string: trimmed, de-duplicated, in order. */
const words = (s) => [...new Set(s.split(',').map(w => w.trim()).filter(Boolean))];

// ---- PEOPLE ----
// One melting pot for the whole system: Belters, Martians and Earthers all
// descend from everywhere.

const GIVEN = words(`
  Amara, Chidi, Ngozi, Kwame, Ama, Kofi, Abena, Yaw, Femi, Tunde, Folake, Adaeze, Emeka, Nnamdi, Zainab, Amina, Fatima, Aisha, Halima, Musa,
  Ibrahim, Yusuf, Omar, Layla, Samira, Karim, Tariq, Rashid, Nadia, Leila, Dariush, Shirin, Parisa, Reza, Farah, Selin, Emre, Elif, Deniz, Kerem,
  Aylin, Tomasz, Agnieszka, Kasia, Pavel, Irina, Natalia, Dmitri, Sergei, Olga, Yelena, Mikhail, Anya, Bogdan, Mirela, Vesna, Goran, Jana, Petra,
  Lukas, Matthias, Greta, Ingrid, Sigrid, Astrid, Bjorn, Leif, Sven, Freya, Halvard, Torvald, Aino, Eero, Saara, Niamh, Siobhan, Aoife, Ciaran,
  Declan, Eamon, Bronwyn, Rhys, Gareth, Isla, Fiona, Callum, Hamish, Elodie, Margaux, Lucien, Remy, Aurelie, Thibault, Matteo, Giulia, Lorenzo,
  Chiara, Bianca, Sofia, Alessandro, Paola, Ines, Joao, Tiago, Beatriz, Rafaela, Caio, Luana, Diego, Mateo, Camila, Valentina, Ximena, Santiago,
  Lucia, Esperanza, Alejandro, Marisol, Inti, Quilla, Amaru, Wayra, Nayeli, Citlali, Itzel, Mabel, Agnes, Edith, Harriet, Winifred, Rosalind,
  Beatrix, Cordelia, Josephine, Theodora, Hazel, Ruth, Martha, Clara, Eleanor, Frances, Violet, June, Mae, Hattie, Abigail, Samuel, Elijah, Jonah,
  Ezra, Silas, Amos, Gideon, Tobias, Ansel, Wendell, Otis, Calvin, Rufus, Jasper, Felix, Hugo, Oscar, Emil, Arthur, Walter, Harold, Cornelius,
  Augustus, Barnaby, Ignatius, Percival, Mei, Lin, Xiu, Jing, Wei, Hao, Jun, Ming, Bao, Lei, Yan, Zhen, Qing, Hui, Hiroshi, Kenji, Yuki, Haruka,
  Sakura, Takeshi, Akira, Emiko, Noriko, Daisuke, Kaito, Ren, Minjun, Jiwoo, Seoyeon, Hyejin, Daeho, Sungmin, Priya, Anjali, Arjun, Vikram, Meera,
  Lakshmi, Deepa, Sanjay, Kavya, Rohan, Aditi, Nikhil, Sunita, Farhan, Rahim, Tahmina, Nusrat, Imran, Kiran, Thanh, Linh, Minh, Huong, Duc, Anh,
  Somchai, Malee, Arief, Dewi, Putri, Budi, Sari, Joko, Rizal, Marisa, Jomari, Teodoro, Ligaya, Mahina, Kai, Keoni, Leilani, Tane, Aroha, Wiremu,
  Mere, Ihaia, Sione, Losa, Tavita, Malia, Talia, Thandiwe, Sipho, Themba, Nomvula, Zodwa, Lindiwe, Bongani, Kagiso, Lerato, Tendai, Rudo, Tatenda,
  Wanjiru, Njeri, Achieng, Baraka, Zawadi, Juma, Neema, Imani, Asha, Makena, Abebe, Selam, Tsehay, Dawit, Mekdes, Yonas, Hanna, Ilse, Anke, Dagny,
  Hedda, Solveig, Ottilie, Oona, Maeve, Rosa, Pilar, Carmen, Dolores, Consuelo, Fernanda, Lourdes, Ofelia, Josefina, Anouk, Bram, Joost, Femke,
  Pieter, Willem, Katya, Oksana, Taras, Zoran, Dragan, Branka, Nikos, Eleni, Yiannis, Dimitra, Stavros, Ariadne, Eitan, Noa, Yael, Tamar, Mira,
  Esme, Ottoline, Bartholomew, Ezekiel, Lazarus, Magnus, Ragnhild, Thora, Dunya, Zarina, Bakhyt, Aigerim, Temujin, Oyuun, Batbayar, Tenzin, Pema,
  Dorje, Lhamo`);

const FAMILY = words(`
  Okafor, Adeyemi, Okonkwo, Mensah, Asante, Boateng, Owusu, Nwosu, Obi, Balogun, Danjuma, Abubakar, Diallo, Traore, Keita, Coulibaly, Toure, Ndiaye,
  Sow, Diop, Ndlovu, Dlamini, Khumalo, Mokoena, Nkosi, Mahlangu, Moyo, Chikwanha, Mutasa, Banda, Phiri, Mwangi, Kamau, Otieno, Odhiambo, Wambui,
  Kiprop, Chebet, Haile, Tesfaye, Bekele, Girma, Alemu, Abdi, Warsame, Haddad, Khoury, Nasser, Mansour, Saleh, Hakimi, Benali, Amrani, Ziani, Tazi,
  Rahmani, Karimi, Hosseini, Tehrani, Farahani, Sadeghi, Yilmaz, Demir, Kaya, Celik, Aydin, Ozturk, Arslan, Petrov, Volkov, Sokolov, Morozov,
  Lebedev, Kuznetsov, Orlov, Belov, Zaitsev, Novak, Kowalski, Wisniewski, Zielinski, Lewandowski, Horvat, Kovac, Babic, Petrovic, Jovanovic,
  Popescu, Ionescu, Dumitru, Kovacs, Nagy, Szabo, Toth, Dvorak, Novotny, Svoboda, Halvorsen, Lindqvist, Johansson, Nyberg, Bergstrom, Sandvik,
  Haugen, Solberg, Virtanen, Lahtinen, Koskinen, Jensen, Thorsen, Magnusson, Sigurdsson, O'Brien, Gallagher, Byrne, Doyle, Kavanagh, Quinn, MacLeod,
  Campbell, Fraser, Morgan, Pryce, Llewellyn, Trevelyan, Penhaligon, Ashworth, Whitlock, Fairweather, Hargreaves, Pemberton, Thornbury, Kettering,
  Blackwood, Holloway, Merriweather, Beaumont, Delacroix, Moreau, Laurent, Fontaine, Girard, Lefebvre, Marchand, Rousseau, Duval, Aubert, Bertrand,
  Rossi, Romano, Esposito, Bianchi, Ricci, Moretti, Ferraro, Conti, Galli, Marino, Lombardi, Ferreira, Pereira, Almeida, Carvalho, Ribeiro, Rocha,
  Barbosa, Cardoso, Teixeira, Moura, Garcia, Fernandez, Lopez, Martinez, Sanchez, Romero, Navarro, Torres, Ramirez, Vargas, Castillo, Herrera,
  Medina, Aguilar, Mendoza, Rojas, Quispe, Mamani, Huaman, Condori, Cruz, Reyes, Santos, Bautista, Villanueva, Aquino, Dizon, Mercado, Pangilinan,
  Nguyen, Tran, Pham, Hoang, Vu, Dang, Bui, Ngo, Sato, Suzuki, Takahashi, Tanaka, Watanabe, Ito, Yamamoto, Nakamura, Kobayashi, Kato, Yoshida,
  Yamada, Sasaki, Matsumoto, Inoue, Kimura, Hayashi, Shimizu, Mori, Ikeda, Hashimoto, Ishikawa, Ogawa, Fujita, Okada, Kim, Lee, Park, Choi, Jung,
  Kang, Cho, Yoon, Jang, Lim, Han, Seo, Shin, Kwon, Hwang, Ahn, Wang, Li, Zhang, Liu, Chen, Yang, Huang, Zhao, Wu, Zhou, Xu, Sun, Zhu, Hu, Guo, Gao,
  Luo, Zheng, Liang, Xie, Song, Tang, Feng, Deng, Cao, Peng, Zeng, Xiao, Tian, Dong, Pan, Yuan, Cai, Jiang, Du, Ye, Cheng, Su, Ding, Shen, Yao,
  Zhong, Cui, Tan, Wen, Fang, Shi, Bai, Kong, Patel, Sharma, Singh, Kumar, Gupta, Reddy, Rao, Iyer, Nair, Menon, Pillai, Chatterjee, Banerjee,
  Mukherjee, Das, Bose, Sen, Ghosh, Desai, Joshi, Kulkarni, Deshpande, Pandey, Mishra, Verma, Chaudhary, Malhotra, Kapoor, Mehta, Shah, Bhatt,
  Krishnan, Subramanian, Venkataraman, Rahman, Hossain, Chowdhury, Siddiqui, Qureshi, Malik, Khan, Hussain, Akhtar, Javed, Wijaya, Santoso, Hartono,
  Kusuma, Gunawan, Setiawan, Pratama, Saputra, Hidayat, Wongsakul, Srisai, Chaiyaporn, Kealoha, Kahananui, Makoa, Ngata, Parata, Tamihana, Fonoti,
  Tuilagi, Faleolo, Tupou, Vaipulu, Fifita, Kowalczyk, Grabowski, Mazur, Krawczyk, Bauer, Fischer, Weber, Schneider, Hoffmann, Richter, Neumann,
  Zimmermann, Hartmann, Lindgren, Ekström, Van der Berg, De Vries, Bakker, Visser, Smit, Mulder, De Jong, Brouwer`);

/** Titles before a family name ("Old Halvorsen") and before a full name ("Captain Amara Okafor"). */
const TITLE = words(`
  Captain, Old, Auntie, Uncle, Doctor, Granny, Grandpa, Big, Little, Mama, Papa, Doc, Skipper, Chief, Cousin, Saint, Miss, Mister, Nana, Baba`);
const TITLE_FULL = words(`Captain, Doctor, Professor, Lady, Saint, Commodore, Mother, Sister, Brother, Auntie, Uncle, Elder`);

// ---- SHARED VOCABULARY ----

const ADJ = words(`
  Lucky, Bright, Silent, Wandering, Patient, Faithful, Steady, Bold, Brave, Proud, Restless, Lonely, Gentle, Quiet, Wild, Free, Distant, Endless,
  Ancient, Young, Old, New, Last, First, Little, Grand, Golden, Silver, Crimson, Blue, Green, Black, White, Grey, Amber, Scarlet, Indigo, Violet,
  Velvet, Midnight, Morning, Evening, Twilight, Summer, Winter, Autumn, Hidden, Secret, Honest, Humble, Merry, Jolly, Stubborn, Clever, Curious,
  Hopeful, Fearless, Dauntless, Tireless, Careless, Reckless, Sleepless, Sudden, Swift, Long, Far, Deep, High, Bitter, Sweet, Salty, Sharp, Soft,
  Warm, Burning, Shining, Fading, Rising, Turning, Drifting, Dancing, Singing, Laughing, Dreaming, Waking, Wayward, Errant, Roving, Valiant,
  Gallant, Noble, Modest, Earnest, Loyal, True, Constant, Plucky, Feisty, Cheeky, Saucy, Sly, Wise, Foolish, Lost, Borrowed, Lucid, Quixotic, Stoic,
  Jaunty, Dapper, Rakish, Sterling, Unlikely, Improbable, Reluctant, Tenacious`);

/** What someone owns: "Mabel's Folly", "Halvorsen's Luck". */
const THING = words(`
  Luck, Folly, Pride, Promise, Wager, Dream, Revenge, Gift, Fortune, Hope, Joy, Grace, Secret, Lament, Choice, Bargain, Errand, Gambit, Garden,
  Lantern, Legacy, Burden, Fancy, Whim, Delight, Comfort, Courage, Patience, Mercy, Doubt, Regret, Rescue, Ransom, Reward, Redemption, Reckoning,
  Return, Refuge, Retirement, Pension, Inheritance, Dowry, Treasure, Trinket, Bauble, Kettle, Teapot, Wheelbarrow, Bicycle, Umbrella, Fiddle, Banjo,
  Accordion, Ukulele, Harmonica, Lullaby, Ballad, Hymn, Prayer, Vow, Oath, Answer, Riddle, Puzzle, Joke, Wink, Farewell, Welcome, Homecoming,
  Adventure, Escape, Getaway, Hideaway, Daydream, Ambition, Obsession, Passion, Devotion, Temper, Notion, Scheme, Gamble, Mistake, Blunder, Triumph,
  Glory, Sorrow, Laughter, Mule, Goat, Hound, Parrot, Canary, Pony, Sweetheart`);
const POS_ADJ = words(`
  Last, Second, Third, Little, Big, Old, New, Lucky, Golden, Only, Secret, Lost, Final, Best, Sweet, Wild, Bright, Long, True, Great, Late, Sudden,
  Foolish, Hidden, Favorite`);

/** "{ofHead} of {place}" and "{ofHead} of {abstract}": "Spirit of Valparaíso", "Song of Ice". */
const OF_HEAD = words(`
  Pride, Spirit, Star, Daughter, Son, Rose, Pearl, Jewel, Light, Heart, Hope, Song, Queen, Lady, Belle, Grace, Voice, Dream, Child, Promise,
  Lantern, Bell, Flower, Wind, Wonder, Glory, Soul, Breath, Gift, Ghost, Bride, Keeper, Sweetheart, Darling, Treasure, Ballad, Hymn, Echo, Pilgrim`);
const ABSTRACT = words(`
  Ice, Iron, Stone, Dust, Light, Fire, Silence, Morning, Evening, Distance, Patience, Plenty, Mercy, Fortune, Ages, Home, Stars, Rain, Thunder,
  Glass, Salt, Silver, Gold, Water, Air, Memory, Wonder, Longing, Kindness, Sorrow, Joy, Laughter, Summer, Winter, Spring, Autumn, Twilight, Dawn,
  Dusk, Midnight, Noon, Tides, Rivers, Mountains, Valleys, Orchards, Gardens, Harvests, Strangers, Travelers, Wanderers, Small Mercies,
  Second Chances, Peace, Quiet, Hours, Years, Miles, Far Places, Old Friends`);

const PHRASE = words(`
  Born Lucky, Never Twice, Against the Odds, Second Wind, Fair Winds, Following Sea, Long Way Home, Almost Home, Home Again, Far From Home,
  Good Enough, Close Enough, Why Not, What If, Just Because, No Regrets, No Hurry, Take Your Time, All in Good Time, Slow and Steady,
  Steady As She Goes, Here Goes Nothing, Worth a Try, Who Knows, Wait and See, Better Late, Still Here, Still Flying, Against All Advice,
  Mother Was Right, Told You So, Odds and Ends, Bits and Pieces, Nuts and Bolts, Spit and Polish, Odd Job, Tall Order, Even Keel, Full Measure,
  Lucky Break, Leap of Faith, Labor of Love, Pride and Joy, Heart's Desire, Wishful Thinking, Lucky Penny, Bad Penny, Happy Accident,
  Many Happy Returns, Once More, Ever After, Ever Onward, Outward Bound, Somewhere Else, Elsewhere, Make Do, Mend and Fly`);

/** Phrase names: "Chasing Daylight", "Running on Fumes", "Postcard from Pallas". */
const GOING = words(`
  Chasing, Dancing with, Running on, Waiting for, Sailing into, Racing past, Dreaming of, Burning for, Born of, Bound for, Riding on, Living on,
  Searching for, Looking for, Reaching for, Falling for, Flying on, Drifting toward, Coasting on, Singing to, Laughing at, Hiding from,
  Running from, Sleeping through, Counting on, Betting on, Banking on, Praying for, Hoping for, Wishing on, Paying for, Living for, Out of,
  Short on, Rich in, Late for, Far from, Fresh from, Home to, Farewell to, Postcard from, Letter to, Love from, Last Out of, Never Without,
  Nothing but`);
const GOING_OBJ = words(`
  Dawn, Dusk, Midnight, Daylight, Starlight, Summer, Winter, Rain, Thunder, Home, Glory, Gold, Silver, Trouble, Luck, Fortune, Freedom, Tomorrow,
  Yesterday, Morning, Shadows, Ghosts, Comets, Dreams, Hope, Faith, Fumes, Credit, Borrowed Time, Thin Air, Thin Ice, Coffee, Noodles, Promises,
  Rumors, the Sun, the Tide, the Wind, the Light, Better Days, Old Times, Good News, Payday, Pocket Change, Spare Parts, Sealant, Prayers,
  Second Chances, Last Orders, Fair Weather`);

/** Trader's gallows humour: "Fourth Mortgage", "Not Insured", "Hostile Takeover", "Halvorsen's Third Loan". */
const ORDINAL = words(`Second, Third, Fourth, Fifth, Sixth, Seventh, Eighth, Ninth, Tenth, Eleventh, Twelfth, Last, Final, Latest, Another`);
const ORD_NOUN = words(`
  Mortgage, Chance, Notice, Warning, Payment, Opinion, Attempt, Marriage, Wind, Thought, Try, Loan, Lien, Extension, Installment, Reminder, Demand,
  Appeal, Divorce, Honeymoon, Career, Coming, Act, Helping, Round, Draft, Coat of Paint, Patch, Engine, Owner, Captain, Name, Life, Wife, Husband,
  Guess, Wish, Refit, Overhaul, Bankruptcy, Partner, Rescue, Insurer, Lawyer, Excuse`);
const DEBT_ADJ = words(`
  Bad, Late, Overdue, Unpaid, Outstanding, Deferred, Creative, Questionable, Hostile, Friendly, Pending, Disputed, Accrued, Compound, Petty, Gross,
  Frozen, Liquid, Leveraged, Unsecured, Subprime, Junk, Variable, Negative, Marginal, Delinquent, Optimistic, Imaginary`);
const DEBT_NOUN = words(`
  Debt, Credit, Invoice, Interest, Margin, Loan, Lien, Payment, Collection, Settlement, Account, Balance, Audit, Takeover, Merger, Expense,
  Accounting, Receivable, Liability, Collateral, Deductible, Premium, Clause, Option, Asset, Equity, Overdraft, Mortgage, Bond, Dividend, Yield,
  Assessment, Arrears, Surcharge, Penalty, Fee, Tariff, Levy, Bailout, Writeoff, Refund, Rebate, Estimate, Quote`);
const NOT_X = words(`
  Insured, Stolen, Yours, Again, Today, Paid For, Pretty, Sorry, Guilty, Haunted, Broken, Finished, Leaking, Lost, Late, Listening, For Sale,
  Responsible, Interested, Impressed, Amused, Covered, Applicable, Negotiable, Refundable, Airtight, Quite, Dead Yet, Done Yet, There Yet,
  Your Business, A Smuggler, Our Problem, That Fast, Entirely Legal, Up to Code`);
const NEVER_X = words(`
  Twice, Late, Paid, Again, Satisfied, Empty, Sober, Sorry, Finished, Clean, Quiet, Bored, Settled, Home, Ready, Wrong, Mind, Better, Cheaper,
  Faster, Alone, Asked, Promised, Insured, Tomorrow, Sideways, Look Back, On Time, Audited`);
const TRADER_PHRASE = words(`
  Debt Collector, Cash Only, No Questions, Ask Me Later, Credit Pending, Almost Paid Off, Still Paying, Last Payment, Bank's Ship,
  Owned by the Bank, Repo Pending, Two Payments Behind, Lien on Me, Under Water, Buyer Beware, Best Offer, Make an Offer, Price Negotiable,
  All Sales Final, No Returns, Small Print, Fine Print, Rounding Error, Act of God, Force Majeure, Plausible Deniability, Margin Call, Sunk Cost,
  Due Diligence, Golden Parachute, Silent Partner, Junior Partner, Off the Books, Petty Cash, Expense Account, Loss Leader, Cost Plus, Thin Margins,
  Cash Flow, Overextended, Mostly Legal, Paperwork Pending, Receipts Available`);

// ---- CULTURES ----

const UN_PLACE = words(`
  Lagos, Valparaíso, Mombasa, Manila, Jakarta, Dhaka, Karachi, Mumbai, Chennai, Kolkata, Colombo, Yangon, Bangkok, Hanoi, Shanghai, Guangzhou,
  Tianjin, Busan, Incheon, Osaka, Kobe, Yokohama, Nagasaki, Kyoto, Sapporo, Vladivostok, Darwin, Perth, Sydney, Brisbane, Auckland, Wellington,
  Suva, Apia, Honolulu, Anchorage, Vancouver, Seattle, San Diego, Acapulco, Veracruz, Havana, Kingston, Cartagena, Maracaibo, Caracas, Belem,
  Recife, Salvador, Santos, Montevideo, Buenos Aires, Rosario, Ushuaia, Punta Arenas, Lima, Callao, Guayaquil, Quito, Cusco, La Paz, Antofagasta,
  Halifax, Boston, Baltimore, Savannah, New Orleans, Galveston, Chicago, Toronto, Montreal, Quebec, Reykjavik, Bergen, Tromso, Oslo, Gothenburg,
  Copenhagen, Hamburg, Bremen, Rotterdam, Antwerp, Le Havre, Brest, Bilbao, Lisbon, Porto, Cadiz, Seville, Marseille, Genoa, Naples, Venice,
  Trieste, Split, Piraeus, Thessaloniki, Izmir, Istanbul, Odessa, Batumi, Alexandria, Port Said, Jeddah, Aden, Muscat, Basra, Zanzibar,
  Dar es Salaam, Maputo, Durban, Cape Town, Walvis Bay, Luanda, Libreville, Douala, Accra, Abidjan, Dakar, Banjul, Freetown, Monrovia, Casablanca,
  Tangier, Tunis, Nairobi, Addis Ababa, Kinshasa, Kampala, Kigali, Lusaka, Harare, Timbuktu, Kano, Ibadan, Delhi, Lahore, Kathmandu, Lhasa,
  Ulaanbaatar, Almaty, Samarkand, Bukhara, Tbilisi, Yerevan, Baku, Isfahan, Shiraz, Damascus, Beirut, Amman, Cairo, Luxor, Khartoum, Geneva, Vienna,
  Prague, Krakow, Dublin, Galway, Edinburgh, Cardiff, Sicily, Sardinia, Crete, Cyprus, Malta, Madagascar, Mauritius, Seychelles, Sri Lanka, Sumatra,
  Borneo, Java, Bali, Luzon, Mindanao, Hokkaido, Kyushu, Okinawa, Tasmania, Aotearoa, Fiji, Samoa, Tonga, Tahiti, Hawaii, Greenland, Svalbard,
  Iceland, Faroe, Shetland, Orkney, Hebrides, Azores, Madeira, Canaries, Cape Verde, Zanzibar, Socotra, Patagonia, Yukon, Tranquility, Imbrium,
  Crisium, Copernicus, Clavius, Shackleton, Aristarchus, Grimaldi, Ptolemaeus, Alphonsus, Plato, Serenitatis, Nectaris, Fecunditatis, Procellarum,
  Tsiolkovskiy, Apollo, Malapert, Peary, Daedalus`);
const UN_ADJ = words(`
  Bright, Gentle, Kind, Blue, Green, Fond, Dear, Proud, Gracious, Generous, Fair, Sunny, Southern, Northern, Eastern, Western, Pacific, Atlantic,
  Tropic, Coastal, Harbor, Spring, Monsoon, Equatorial, Seaborne, Bluewater, Meadow, Orchard, Garden, Homeward, Terran, Lunar, Golden, Grand, Merry,
  Blessed, Cherished, Beloved, Treasured, Precious, Gilded, Prosperous, Thriving, Sustainable, Global, United, Allied, Consolidated, Integrated,
  Strategic, Premier, Prime, Optimal, Dynamic, Agile, Leveraged, Scalable, Diversified, Synergistic, Sunlit, Rainy, Breezy, Balmy, Leafy, Mellow,
  Hearty, Wholesome, Earthy, Sentimental, Nostalgic, Homesick`);
const UN_NOUN = words(`
  Promise, Hope, Dream, Pride, Grace, Blessing, Heart, Sunrise, Sunset, Harbor, Homecoming, Lantern, Garden, Orchard, Meadow, Rose, Lily, Jasmine,
  Lotus, Orchid, Magnolia, Camellia, Peony, Marigold, Hibiscus, Frangipani, Bougainvillea, Tide, Current, Breeze, Tradewind, Gale, Swell, Reef,
  Lagoon, Shore, Strand, Haven, Anchorage, Lighthouse, Beacon, Compass, Sextant, Albatross, Petrel, Heron, Crane, Pelican, Cormorant, Gull, Tern,
  Dolphin, Orca, Marlin, Manta, Turtle, Whale, Seahorse, Coral, Pearl, Jade, Opal, Sapphire, Legacy, Heritage, Commonwealth, Accord, Charter,
  Covenant, Dividend, Equity, Portfolio, Holding, Trust, Partnership, Synergy, Paradigm, Initiative, Solution, Logistics, Outcome, Mandate,
  Stakeholder, Benchmark, Milestone, Deliverable, Bottom Line, Growth, Rainbow, Sunbeam, Moonbeam, Earthrise, Bluebird, Robin, Nightingale, Lark,
  Wren, Kingfisher, Monsoon, Riverboat, Seashell, Sandcastle`);
/** Earth shipping houses name a whole fleet with one word: "Kepler Bright", "Mercator Promise". */
const UN_HOUSE = words(`
  Kepler, Lagrange, Halcyon, Sterling, Pacifica, Atlantica, Concordia, Arcturus, Polaris, Tasman, Coriolis, Zenith, Equinox, Cardinal, Solstice,
  Mercator, Hadley, Okeanos, Novaterra, Bluewater, Sunward, Lunaris, Orbis, Meridiana, Ecliptic, Perihelion, Apogee, Libration, Syzygy, Albedo,
  Parallax, Terminus, Heliotrope`);
const UN_PHRASE = words(`
  Homeward Bound, Following Seas, Good Hope, Safe Harbor, Fortune Favors, Godspeed, Bon Voyage, Smooth Sailing, Blue Horizon, Sea Change,
  Mother's Pride, Family Business, Quarterly Target, Board Approved, Shareholder Value, Going Concern, Blue Chip, Growth Forecast, Fiscal Year,
  Annual Report, Synergy Achieved, Core Competency, Value Added, Best Practice, Market Leader, Ahead of Schedule`);

const MARS_PLACE = words(`
  Tharsis, Hellas, Arsia, Valles, Olympus, Noctis, Elysium, Pavonis, Ascraeus, Argyre, Utopia, Acidalia, Arcadia, Amazonis, Chryse, Isidis, Syrtis,
  Hesperia, Cimmeria, Sirenum, Sabaea, Arabia, Meridiani, Xanthe, Lunae, Tempe, Mareotis, Kasei, Ares Vallis, Ma'adim, Nirgal, Gale, Jezero, Gusev,
  Holden, Eberswalde, Huygens, Schiaparelli, Herschel, Korolev, Lomonosov, Antoniadi, Lyot, Bonestell, Milankovic, Vastitas, Planum Boreum,
  Promethei, Malea, Hadriacus, Tyrrhenus, Apollinaris, Aeolis, Medusae, Memnonia, Daedalia, Solis, Sinai, Thaumasia, Syria, Claritas, Coprates,
  Candor, Ophir, Melas, Ius, Tithonium, Echus, Hebes, Juventae, Aurorae, Eos, Capri, Margaritifer, Aram, Oxia, Tiu, Simud, Shalbatana, Mawrth, Nili,
  Phlegra, Hecates, Albor, Ceraunius, Uranius, Biblis, Ulysses, Jovis, Alba, Tantalus, Acheron, Erebus, Abalos, Mangala, Mamers, Deuteronilus,
  Protonilus, Cydonia, Nilosyrtis, Amenthes, Libya, Zephyria, Galaxias, Orcus, Hephaestus, Cerberus, Athabasca, Marte, Granicus, Tinjar, Dao,
  Niger Vallis, Harmakhis, Reull, Ladon, Uzboi, Holden Crater, Stickney, Phobos, Deimos, Londres Nova, Innis Shallow, Bradbury, Burroughs, Lowell,
  Sagan, Mariner, Viking, Sojourner, Opportunity, Curiosity, Perseverance, Ingenuity, Zhurong, Tianwen, Mars Station, Ochre Basin, Dustfall,
  Redwater, Highrim, Low Hellas, Ironvale, Coldspring, Firstlight, Kasei Deep, Twin Domes, Canal Town`);
const MARS_ADJ = words(`
  Red, Rust, Ochre, Russet, Crimson, Copper, Iron, Dusty, First, Second, Third, Green, Thawing, Patient, Deep, Long, New, Rising, Frontier, Thin,
  Cold, Stubborn, Earnest, Sober, Diligent, Steadfast, Upright, Dutiful, Hard, Polar, Domed, Terraced, Irrigated, Seeded, Sown, Tilled, Growing,
  Greening, Blooming, Budding, Young, Faithful, Blue, Clear, Pressurized, Sealed, Buried, Tunneled, Highland, Lowland, Canyon, Upland, Honest,
  Common, Shared, Tharsian, Arcadian, Elysian, Hesperian, Amazonian, Noachian, Thrifty, Frugal, Careful, Measured, Precise, Determined, Resolute,
  Unhurried, Hardy, Weathered, Windswept`);
const MARS_NOUN = words(`
  Harvest, Spring, Rain, Seed, Furrow, Dome, Garden, Greening, Thaw, Lichen, Root, Canal, Aquifer, Frontier, Labor, Duty, Covenant, Dawn, Sky,
  Breath, Atmosphere, Pioneer, Homestead, Settler, Terrace, Orchard, Moss, Fern, Sapling, Grove, Wheat, Barley, Algae, Greenhouse, Reservoir,
  Wellspring, Icecap, Glacier, Dust Devil, Sandstorm, Twilight, Sunset, Olivine, Basalt, Regolith, Hematite, Oxygen, Soil, Loam, Compost, Pasture,
  Meadow, Field, Plow, Trowel, Sower, Tiller, Steward, Engineer, Surveyor, Generation, Century, Inheritance, Bequest, Endowment, Charter, Commons,
  Patience, Resolve, Endurance, Perseverance, Diligence, Industry, Craft, Measure, Tolerance, Standard, Blueprint, Survey, Forge, Foundry, Shipyard,
  Keel, Rivet, Pressure Seal, Airlock, Lamp, Hearth, Ration, Bread, Water Right, Firstborn, Promise, Vow, Ochre, Rust, Thunderhead, Rainmaker,
  Cloudseed, Ice Mine, Mirror, Sunlamp, Windbreak`);
/** Mars names its ships after what it hopes for: "Daughter of Hellas", "Bread of Arcadia". */
const MARS_KIN = words(`
  Daughter, Son, Child, Heir, Pride, Hope, Promise, Spirit, Heart, Rose, Seed, Gift, Song, Flower, Light, Bread, Water, Breath, Granddaughter,
  Grandson, Firstborn, Hearth, Lamp, Rain, Harvest, Green`);
/** What Mars is waiting for: "Child of Second Spring", "Daughter of the Long Rain". */
const MARS_HOPE_ADJ = words(`
  First, Second, Third, Red, Green, Thawing, Rising, Deep, Long, New, Young, Blue, Clear, Common, Patient, Highland, Northern, Southern, Open, Warm,
  Greening, Blooming, Coming, Promised, Distant, Hundredth, Last, Early, Gentle`);
const MARS_HOPE_NOUN = words(`
  Harvest, Spring, Rain, Seed, Dome, Garden, Greening, Thaw, Lichen, Root, Canal, Frontier, Dawn, Sky, Breath, Air, Homestead, Terrace, Orchard,
  Moss, Fern, Sapling, Grove, Wheat, Barley, Reservoir, Wellspring, Sunset, Soil, Pasture, Meadow, Field, Generation, Century, Charter, Commons,
  Summer, Ocean, Sea, River, Lake, Cloud, Forest, Valley, Morning, Weather`);
const MARS_PHRASE = words(`
  One Day Rain, Someday Oceans, Open Sky, Under Glass, For the Children, Patience Pays, Hard Work, Duty First, Built to Last, Measure Twice,
  Within Tolerance, To Specification, Inspected and Passed, Sixty Years Yet, Not in Our Lifetime, Plant Trees Anyway, Breathe Easy Someday,
  Mind the Seals, Dust in Everything, The Long Work, Third Generation, Water Rights, Air Rights, Rain on Mars`);

const BELT_PLACE = words(`
  Ceres, Eros, Pallas, Vesta, Hygiea, Tycho, Juno, Psyche, Davida, Interamnia, Sylvia, Eunomia, Cybele, Hektor, Thisbe, Camilla, Bamberga, Iris,
  Hebe, Flora, Metis, Fortuna, Kalliope, Themis, Amphitrite, Egeria, Irene, Massalia, Lutetia, Ida, Gaspra, Mathilde, Kleopatra, Lucina, Herculina,
  Doris, Patientia, Ursula, Elektra, Aletheia, Hermione, Palma, Daphne, Bettina, Diotima, Antiope, Melpomene, Nysa, Alexandra, Pandora, Thetis,
  Iduna, Undina, Hilda, Thule, Achilles, Patroclus, Agamemnon, Diomedes, Aeneas, Odysseus, Nestor, Ajax, Priamus, Troilus, Ennomos, Anchises,
  Callisto, Europa, Io, Titan, Rhea, Iapetus, Enceladus, Mimas, Dione, Tethys, Phoebe, Hyperion, Miranda, Titania, Oberon, Umbriel, Ariel, Triton,
  Nereid, Proteus, Arrokoth, Sedna, Quaoar, Varuna, Ixion, Haumea, Makemake, Eris, Gonggong, Chiron, Pholus, Nessus, Hidalgo, Apophis, Bennu, Ryugu,
  Itokawa, Dactyl, Siwa, Toro, Icarus, Geographos, Toutatis, Castalia, Gaia Rock, Low Ceres, Ceres Dock, Tycho Ring, Eros Deep, Pallas Yard,
  Vesta Spin, Hygiea Gut`);
const BELT_ADJ = words(`
  Rock, Spin, Dust, Hard, Thin, Tight, Patched, Welded, Sealed, Leaky, Salvaged, Rebuilt, Secondhand, Thirdhand, Bent, Tough, Drift, Black, Cold,
  Free, Proud, Low, Zero, Vacuum, Tumbling, Spinning, Hollow, Scrappy, Rusty, Greasy, Sticky, Jury, Makeshift, Borrowed, Scavenged, Stripped,
  Clever, Loud, Grinning, Tattooed, Lanky, Tall, Stretched, Narrow, Outer, Dark, Hungry, Thirsty, Breathing, Pressurized, Spacer, Hardsuit,
  Magnetic, Airless, Cheap, Gritty, Tired, Skinny, Longboned, Spinward, Dented, Lopsided, Wobbly, Mended, Rigged, Riveted, Taped, Bolted, Glued,
  Plugged`);
const BELT_NOUN = words(`
  Rock, Dust, Spin, Drift, Seal, Patch, Weld, Wrench, Magboot, Tether, Airlock, Bulkhead, Gimbal, Thruster, Ice, Water, Air, Breath, Pressure,
  Scrubber, Filter, Sealant, Grease, Torch, Spanner, Rivet, Girder, Rig, Hab, Ring, Tunnel, Shaft, Crawlway, Hand, Glove, Fist, Knuckle, Elbow,
  Bones, Sweat, Debt, Contract, Shift, Wage, Share, Claim, Luck, Chance, Prayer, Kin, Clan, Crew, Family, Home, Hearth, Cradle, Song, Story, Joke,
  Grin, Dance, Ruckus, Racket, Rumble, Hustle, Gamble, Wager, Hymn, Tattoo, Ink, Mark, Sign, Gesture, Nod, Shrug, Wink, Stretch, Reach, Tumble,
  Spiral, Orbit, Tangent, Vector, Burn, Flip, Coast, Slingshot, Ballast, Spindle, Ladder, Hatch, Gasket, Valve, Duct, Pipe, Cable, Bolt, Clamp,
  Strap, Hook, Winch, Hammer, Mallet, Crowbar, Tape, Glue, Mender`);
/**
 * Lang Belta, used with care: attributives ("Sabaka Dust"), nouns ("Old
 * Bosmang") and kin ("Beratna Pampa"). The crude words live only in the
 * fixed phrases, where they land as jokes and not as accidents.
 */
const BELTA_ADJ = words(`Sabaka, Mali, Gut, Xidawang, Beltalowda, Kopeng, Nating`);
const BELTA_NOUN = words(`Kopeng, Beratna, Sésata, Pampa, Bosmang, Beltalowda, Inyalowda, Xidawang, Imalowda, Nating, Taki, Sabaka`);
const BELTA_KIN = words(`Beratna, Sésata, Kopeng, Bosmang, Mali`);
const BELT_PHRASE = words(`
  Beratna Pampa, Mi Imalowda, Ke Rock Tu, Taki Beratna, Nating Kaka, Oye Inyalowda, Beltalowda Gut, Taki Kopeng, Spin Gravity, Air Is Not Free,
  Pay for Air, Breathe Slow, Still Breathing, Sealant and Prayer, Patched Twice, Third Seal, Hold Your Breath, Mind the Lock, Count Your Air,
  Long Bones, Vacuum Baby, Low and Slow, Never Saw Sky, What Is Rain, Sky Is a Lie, Rock Steady, Tight Seals, Five Minutes of Air, Belter Proud,
  Water Is Water, Kaka Weather`);

/** Independents live out by Jupiter and Saturn and trade with everyone. */
const OUTER_PLACE = words(`
  Ganymede, Callisto, Io, Europa, Amalthea, Himalia, Elara, Pasiphae, Sinope, Carme, Ananke, Leda, Thebe, Adrastea, Titan, Rhea, Iapetus, Dione,
  Tethys, Enceladus, Mimas, Hyperion, Phoebe, Janus, Epimetheus, Prometheus, Daphnis, Miranda, Ariel, Umbriel, Titania, Oberon, Triton, Nereid,
  Proteus, Larissa, Charon, Nix, Kerberos, Styx, Galileo Regio, Valhalla, Asgard, Tvashtar, Loki, Pele, Conamara, Kraken Mare, Ligeia, Xanadu,
  Shangri-La, Tiger Stripe, Cassini Gap, Encke Gap, Roche Limit, Lagrange Five`);
const IND_ADJ = words(`
  Free, Independent, Unaligned, Private, Freelance, Chartered, Unbonded, Neutral, Jovian, Saturnine, Galilean, Far-Flung, Out-System, Self-Made,
  Self-Employed, Owner-Operated`);

// ---- TRADES ----
// Each kind of hull adds its own words. The `names` key of a class picks one.

const KIND = {
  prospector: {
    adjK: words(`
      Lucky, Dusty, Rich, Lean, Hollow, Hidden, Buried, Nickel, Cobalt, Iridium, Platinum, Palladium, Tungsten, Copper, Patient, Hopeful, Wandering,
      Lonely, Fool's, Blind, Wildcat, Glittering, Rumored, Untapped, Unclaimed, Staked, Uncharted, Glinting, Faint, Promising, Likely, Canny,
      Gambler's, Seismic, Spectral, Magnetic, Assayed, Pure, Native, Rare, Precious, Shiny, Speculative, Optimistic, Grizzled, Weathered, Solitary,
      Persistent, Grubby, Leathery, Stubborn, Sure, Gleaming, Speckled, Veined, Metallic, Ferrous, Lustrous, Rough, Uncut, Raw, Glimmering,
      Tantalizing, Elusive, Fabled, Legendary, Overlooked, Hardscrabble, Hardluck, Itchy, Wishful, Feverish, Daring, Wildcatting`),
    nounK: words(`
      Strike, Vein, Claim, Pick, Digger, Chance, Lode, Seam, Find, Nugget, Prospect, Survey, Core, Sample, Assay, Stake, Bonanza, Hunch, Spade,
      Drill, Charge, Gamble, Dowser, Echo, Sounding, Grubstake, Mother Lode, Paydirt, Placer, Ore, Ingot, Bullion, Glint, Fleck, Speck, Pebble,
      Boulder, Chondrite, Olivine, Pallasite, Meteorite, Geode, Crystal, Spinel, Garnet, Beryl, Zircon, Probe, Marker, Flag, Cairn, Waypoint,
      Bearing, Instinct, Nose, Whim, Bet, Payday, Windfall, Jackpot, Score, Trove, Cache, Pocket, Stringer, Outcrop, Ledge, Lodestone, Magnet,
      Divining Rod, Rockhound, Sourdough, Panner, Fossicker, Wildcatter, Speculator, Sniffer, Scout, Seeker, Finder, Tracker, Trailblazer,
      Hope Chest, Assayer, Charm, Horseshoe, Clover, Talisman, Amulet, Omen, Inkling, Longshot, Dark Horse, Underdog, Moonshot, Dice, Coin, Ace,
      Wildcard, Lottery, Ticket, Homestake, Deed, Patent, Theodolite, Plumb Bob, Rock Hammer, Loupe, Gold Pan, Spectrum`),
    phraseK: words(`
      Pay Dirt, Long Shot, Strike It Rich, Next Rock Over, One More Rock, Almost There, Dig Deep, Still Looking, Gut Feeling, Lucky Hunch,
      Bet the Farm, Blind Luck, Beginner's Luck, Nothing Yet, Any Day Now, This One's Different, Rich Tomorrow, Worth Its Weight`),
  },
  courier: {
    adjK: words(`
      Swift, Quick, Razor, Fleet, Rapid, Nimble, Hot, Express, Urgent, Running, Flying, Sudden, Light, Slim, Sharp, Blazing, Fast, Darting, Racing,
      Hasty, Eager, Breathless, Headlong, Priority, Overnight, Instant, Lightning, Quicksilver, Mercurial, Winged, Feathered, Streaking, Whistling,
      Humming, Blinking, Flickering, Fleeting, Hurried, Brisk, Zippy, Dashing, Spry, Agile, Lithe, Overdriven, Juiced, Torchlit, Redline, Speedy,
      Hurrying, Galloping, Sprinting, Bounding, Leaping, Soaring, Gliding, Whirling, Rocketing, Bolting, Scudding, Skimming, Flashing, Snappy,
      Timely, Prompt, Early, Airmail, Registered`),
    nounK: words(`
      Arrow, Dart, Wing, Bolt, Needle, Comet, Spark, Hare, Swallow, Swift, Falcon, Merlin, Hummingbird, Mercury, Messenger, Herald, Letter, Packet,
      Runner, Errand, Whisper, Rumor, Flicker, Streak, Dash, Sprint, Blink, Gust, Javelin, Quill, Dispatch, Telegram, Envelope, Parcel, Post, Relay,
      Baton, Hound, Greyhound, Whippet, Cheetah, Gazelle, Antelope, Impala, Jackrabbit, Roadrunner, Sparrowhawk, Peregrine, Swallowtail, Dragonfly,
      Mayfly, Zephyr, Glimmer, Gleam, Glance, Heartbeat, Moment, Instant, Tick, Pulse, Slingshot, Bullet, Tracer, Meteor, Shooting Star, Sprite,
      Pony, Postman, Mailbag, Stamp, Postmark, Memo, Note, Tidings, News, Bulletin, Headline, Kite, Feather, Arrowhead, Lightfoot, Quickstep,
      Starling, Martin, Wagtail, Sandpiper, Plover, Curlew, Snipe, Nighthawk, Nightjar, Goshawk, Osprey, Hobby, Lanner, Saker, Gyrfalcon, Courser,
      Steed, Charger, Mustang, Bronco, Colt, Filly, Thoroughbred, Racehorse, Otter, Darter, Skimmer, Flyer, Sprinter, Racer, Pacer, Telegraph,
      Semaphore, Flare, Rocket, Firecracker`),
    phraseK: words(`
      Overnight Delivery, Signature Required, Return to Sender, Postage Due, Special Delivery, No Waiting, Already Gone, See You There, Just Missed,
      Right Behind You, Before Lunch, Express Lane, Next Day, Time Sensitive, Urgent Reply, Read Receipt, Do Not Bend, First Class, Airmail`),
  },
  shuttle: {
    adjK: words(`
      Short, Steady, Slow, Patient, Faithful, Humble, Plain, Square, Heavy, Tired, Dependable, Busy, Daily, Grey, Fat, Weary, Plodding, Trusty,
      Sturdy, Stout, Squat, Boxy, Dull, Ordinary, Workaday, Everyday, Regular, Reliable, Punctual, Grumpy, Sleepy, Cranky, Creaky, Rattling,
      Clanking, Dented, Scuffed, Battered, Unhurried, Local, Shabby, Homely, Lumpy, Chunky, Clumsy, Doughty, Willing, Obliging, Uncomplaining,
      Overworked, Underpaid, Unloved, Unsung, Unremarkable, Forgettable, Unassuming, Hardworking, Longsuffering, Wheezing, Puffing, Huffing,
      Sputtering, Squeaky, Wellworn, Threadbare, Shopworn, Budget, Economy, Standard, Basic, Utility, Municipal`),
    nounK: words(`
      Runner, Lifter, Cart, Sled, Hop, Box, Barrow, Wagon, Dray, Mule, Donkey, Ox, Tug, Lighter, Ferry, Porter, Trolley, Pallet, Crate, Load,
      Commute, Shift, Bucket, Tote, Workhorse, Packhorse, Pony, Burro, Yak, Camel, Llama, Brick, Shoebox, Lunchbox, Breadbox, Toolbox, Thermos,
      Kettle, Bathtub, Wheelbarrow, Handcart, Forklift, Dolly, Hoist, Winch, Crane, Shuffle, Trundle, Waddle, Trudge, Plod, Slog, Grind, Routine,
      Round, Circuit, Loop, Leg, Jaunt, Milk Run, Turnaround, Shuttle, Bus, Tram, Cable Car, Gondola, Scow, Punt, Raft, Lunchpail, Hardhat,
      Coverall, Boot, Shovel, Doorstop, Paperweight, Hod, Sack, Satchel, Basket, Hamper, Trunk, Suitcase, Carryall, Holdall, Duffel, Rucksack,
      Knapsack, Pannier, Saddlebag, Float, Carthorse, Drayhorse, Hinny, Bullock, Buffalo, Stevedore, Navvy, Drudge, Dogsbody, Gofer, Runabout,
      Jitney, Rickshaw, Trishaw, Pushcart, Skip, Lift`),
    phraseK: words(`
      Same Again, Back Again, There and Back, Milk Run, Night Shift, Clock In, Clock Out, Overtime, Next Stop, Last Stop, Round Trip, Short Hop,
      Up and Down, Heavy Lifting, Load and Go, Mind the Step, Another Day, Union Break, Day Job, Nine to Five`),
  },
  freighter: {
    adjK: words(`
      Far, Wide, Distant, Steady, Prosperous, Fair, Open, Bold, Laden, Loaded, Broad, Ample, Bountiful, Thrifty, Canny, Shrewd, Prudent, Solvent,
      Profitable, Bonded, Chartered, Licensed, Registered, Roving, Questing, Venturing, Mercantile, Commercial, Outbound, Inbound, Homebound,
      Sunward, Spinward, Wholesale, Bulk, Trading, Itinerant, Journeying, Seasoned, Weathered, Reliable, Punctual, Deepspace, Interplanetary,
      Tramping, Overdue, Heavy, Faraway, Merchant, Enterprising, Industrious, Assiduous, Lucrative, Gainful, Flourishing, Burgeoning, Booming,
      Bargain, Discount, Premium, Offworld, Coastwise, Longshore, Freeport, Duty-Free, Cash-Rich, Debt-Free`),
    nounK: words(`
      Venture, Prospect, Horizon, Trader, Fortune, Endeavor, Bounty, Passage, Voyage, Commerce, Merchant, Caravan, Argosy, Margin, Ledger, Dividend,
      Consignment, Manifest, Cargo, Freight, Tonnage, Haul, Shipment, Delivery, Bargain, Barter, Trade, Exchange, Market, Bazaar, Emporium,
      Warehouse, Depot, Wharf, Quay, Pier, Dock, Waypoint, Course, Heading, Route, Lane, Road, Highway, Crossing, Transit, Traverse, Journey,
      Pilgrim, Wayfarer, Nomad, Wanderer, Rover, Drifter, Vagabond, Journeyman, Peddler, Hawker, Chandler, Factor, Broker, Purser, Quartermaster,
      Supercargo, Invoice, Tariff, Packet, Clipper, Galleon, Carrack, Junk, Dhow, Felucca, Schooner, Brigantine, Windjammer, Cog, Caravel, Coaster,
      Steamer, Tramp, Hold, Container, Strongbox, Sea Chest, Hoard, Stockpile, Inventory, Surplus, Abundance, Plenty, Profit, Yield, Premium,
      Commission, Brokerage, Concern, Concession, Franchise, Contract, Warranty, Guarantee, Indemnity, Underwriter, Barque, Ketch, Yawl, Sloop,
      Lugger, Hoy, Wherry, Keelboat, Flatboat, Collier, Merchantman, Indiaman, Bulker, Reefer, Feeder`),
    phraseK: words(`
      Cash on Delivery, Paid in Full, Net Thirty, Terms Apply, No Refunds, Fragile, This Side Up, Handle With Care, Some Assembly Required,
      Lost in Transit, Customs Pending, Bill of Lading, Free on Board, Bonded Goods, Goods in Transit, Sold As Seen, Delivered Duty Paid, Sign Here,
      Ships Today, Batteries Not Included`),
  },
  hauler: {
    adjK: words(`
      Ice, Frost, Cryo, Cold, Weeping, Frozen, Glacial, Winter, Snow, Rime, Hoar, Crystal, Pale, Blue, White, Slow, Ring, Saturnine, Sleeping,
      Dreaming, Melting, Thawing, Calving, Shivering, Numb, Bitter, Polar, Arctic, Boreal, Frigid, Icy, Chill, Wintry, Hyperborean, Stately,
      Ponderous, Lumbering, Majestic, Enormous, Vast, Immense, Mighty, Colossal, Gargantuan, Tremendous, Monumental, Patient, Unhurried, Deliberate,
      Glistening, Shimmering, Translucent, Opalescent, Steaming, Sublimating, Misty, Foggy, Cloudy, Hazy, Snowbound, Icebound, Frostbitten, Rimed,
      Crystalline, Faceted, Cracked, Fractured, Splintered, Weighty, Burdened, Overburdened, Mountainous, Elephantine`),
    nounK: words(`
      Hauler, Mule, Ox, Dray, Somnambulist, Glacier, Berg, Floe, Iceberg, Comet, Snowball, Shard, Lake, Sea, River, Cistern, Reservoir, Well,
      Spring, Rain, Thaw, Melt, Tide, Shelf, Pack, Icicle, Snowflake, Snowdrift, Avalanche, Blizzard, Sleet, Hail, Slush, Permafrost, Tundra, Fjord,
      Crevasse, Moraine, Cirque, Serac, Nunatak, Firn, Hailstone, Waterbearer, Mammoth, Mastodon, Walrus, Narwhal, Beluga, Leviathan, Behemoth,
      Colossus, Giant, Elephant, Whale, Bowhead, Rorqual, Humpback, Ark, Cathedral, Mountain, Continent, Island, Tower, Monolith, Bison, Musk Ox,
      Caribou, Reindeer, Snowmelt, Meltwater, Floodgate, Aqueduct, Water Tower, Iceblock, Igloo, Ice Palace, Polar Bear, Penguin, Brook, Creek,
      Stream, Rill, Beck, Cascade, Waterfall, Rapids, Estuary, Delta, Bay, Sound, Loch, Mere, Tarn, Oasis, Raindrop, Dewdrop, Teardrop, Watershed,
      Headwater, Snowcap, Icefield, Iceshelf, Icefall, Frost Giant, Ymir, Snow Queen, Yeti, Rhino, Sauropod, Diplodocus, Moose, Elk`),
    phraseK: words(`
      Slow Boat, Long Way Round, Cold Comfort, Thin Ice, Six Months Out, Saturn and Back, Still Frozen, Keep Cold, Chilled to Order, Water Is Life,
      Ice Is Nice, Break the Ice, On the Rocks, Snow Day, Cold Feet, Frozen Assets, Rings and Back, Big and Slow, Mind the Drip`),
  },
  tanker: {
    adjK: words(`
      Full, Heavy, Wet, Brimming, Fat, Round, Thirsty, Generous, Volatile, Bulging, Sloshing, Gurgling, Bubbling, Pressurized, Cryogenic, Liquid,
      Fluid, Viscous, Slick, Slippery, Fuming, Vaporous, Bottomless, Overflowing, Plump, Portly, Stout, Rotund, Bloated, Swollen, Tipsy, Sober,
      Quenched, Parched, Reserve, Spare, Topped, Spilling, Dripping, Leaking, Gassy, Frosty, Chilled, Boiling, Supercooled, Distilled, Refined,
      Crude, Syrupy, Honeyed, Treacly, Bubbly, Effervescent, Frothy, Foamy, Milky, Murky, Potent, Heady, Strong, Diluted, Concentrated, Fortified,
      Vintage, Smooth, Brimful, Bursting, Ballooning, Inflated, Potbellied, Paunchy, Thick, Dense`),
    nounK: words(`
      Tank, Belly, Drum, Well, Barrel, Cask, Keg, Vat, Bladder, Flask, Gourd, Jug, Bottle, Reservoir, Cistern, Font, Fountain, Draught, Measure,
      Pour, Pint, Gallon, Tankard, Flagon, Decanter, Carafe, Ewer, Pitcher, Canteen, Pail, Trough, Basin, Pool, Pond, Flood, Torrent, Deluge,
      Downpour, Wellspring, Fountainhead, Source, Supply, Stock, Store, Hoard, Ration, Refill, Siphon, Pump, Valve, Nozzle, Hose, Pipe, Spigot, Tap,
      Bung, Stopper, Cork, Plug, Gusher, Geyser, Hydrogen, Deuterium, Methane, Ammonia, Propellant, Fuel, Reaction Mass, Slurry, Brine, Distillate,
      Vapor, Bubble, Fizz, Splash, Drop, Droplet, Puddle, Thirst, Watering Can, Demijohn, Amphora, Urn, Jar, Cauldron, Boiler, Tun, Hogshead,
      Firkin, Kilderkin, Puncheon, Carboy, Jerrycan, Hip Flask, Wineskin, Waterskin, Gasbag, Windbag, Hiccup, Gulp, Swig, Sip, Slurp, Quaff, Tipple,
      Nightcap, Libation, Elixir, Tonic, Potion, Brew`),
    phraseK: words(`
      Fill Her Up, Top Off, Last Drop, Bottoms Up, One for the Road, Running on Fumes, Half Full, Never Empty, Volatile Cargo, Do Not Shake,
      No Smoking, Keep Upright, Contents Under Pressure, Mind the Spill, Drink Up, Fill to the Line, Fueled and Ready, Plenty More, Spare Tank`),
  },
  barge: {
    adjK: words(`
      Rock, Ore, Gravel, Stone, Grinding, Crushing, Hungry, Slag, Rubble, Heavy, Slow, Deep, Black, Grey, Dusty, Chewing, Gnashing, Gnawing,
      Rumbling, Grumbling, Groaning, Clattering, Thundering, Shuddering, Pounding, Hammering, Boring, Drilling, Smelting, Molten, Glowing, Sintered,
      Crushed, Broken, Shattered, Greedy, Ravenous, Insatiable, Methodical, Tireless, Relentless, Industrious, Laborious, Gritty, Grimy, Sooty,
      Smoky, Toothy, Voracious, Gluttonous, Omnivorous, Chomping, Munching, Crunching, Champing, Digesting, Belching, Growling, Snarling, Abrasive,
      Caustic, Scorching, Searing, Blistering, Incandescent, Fiery, Unstoppable, Unrelenting, Ceaseless, Monstrous, Hulking, Brutish, Gigantic,
      Cyclopean`),
    nounK: words(`
      Breaker, Crusher, Chewer, Grinder, Smelter, Furnace, Anvil, Hammer, Maw, Jaw, Mill, Quarry, Pit, Shovel, Dredge, Auger, Bore, Drill, Pick,
      Chisel, Forge, Crucible, Kiln, Stamp, Sieve, Sluice, Riddle, Screen, Hopper, Chute, Conveyor, Bucket, Scoop, Grab, Claw, Mandible, Molar,
      Tooth, Tusk, Gizzard, Stomach, Gut, Appetite, Stonecutter, Mason, Quarrier, Delver, Excavator, Ram, Pile Driver, Battering Ram, Wrecking Ball,
      Sledgehammer, Mattock, Pickaxe, Crowbar, Jackhammer, Rock Drill, Mole, Badger, Wombat, Armadillo, Pangolin, Aardvark, Termite, Beetle, Weevil,
      Worm, Grub, Locust, Glutton, Gourmand, Ogre, Troll, Digester, Refinery, Foundry, Slagheap, Tailings, Spoil, Gravel Pit, Rockpile, Millstone,
      Grindstone, Mortar, Pestle, Quern, Stamper, Trommel, Concentrator, Separator, Sorter, Roaster, Retort, Bloomery, Blastfurnace, Converter,
      Puddler, Ladle, Bellows, Billet, Bloom, Minecart, Headframe, Adit, Stope, Winze, Crosscut, Overburden, Gangue, Matte, Dross, Clinker, Cinder,
      Behemoth, Leviathan`),
    phraseK: words(`
      Breaking Rocks, Chew On This, Bite Size, Rock Bottom, Heavy Metal, Nickel and Dime, Stone Cold, Hard Rock, Rocks for Brains, Grind Time,
      Rock and Roll, Small Pieces, Mind the Dust, Ore Else, Second Helping, Crunch Time, Smashing Time, Rubble Trouble, Sticks and Stones`),
  },
  liner: {
    // "{line} {adjK} {nounK}": "Ceres Express Morning Pearl".
    adjK: words(`
      Morning, Evening, Silver, Golden, Grand, Gentle, Serene, Radiant, Celestial, Starlit, Crystal, Velvet, Pearl, Azure, Emerald, Sapphire, Amber,
      Rose, Royal, Majestic, Elegant, Graceful, Splendid, Glorious, Luminous, Shining, Gleaming, Sparkling, Twilight, Midnight, Moonlit, Sunlit,
      Summer, Spring, Autumn, Winter, Southern, Northern, Distant, Faraway, Enchanted, Charmed, Dreaming, Floating, Gilded, Jeweled, Opaline,
      Silken, Lavender, Ivory, Coral, Crimson, Cerulean, Halcyon, Tranquil, Blissful`),
    nounK: words(`
      Star, Pearl, Grace, Rose, Lily, Swan, Dawn, Voyage, Crown, Jewel, Belle, Queen, Princess, Countess, Lady, Dream, Song, Promise, Garden,
      Pavilion, Palace, Terrace, Promenade, Ballroom, Salon, Gallery, Orchestra, Symphony, Sonata, Serenade, Waltz, Minuet, Nocturne, Rhapsody,
      Overture, Reverie, Idyll, Arcadia, Paradise, Odyssey, Sojourn, Holiday, Cruise, Excursion, Escapade, Discovery, Wonder, Marvel, Splendor,
      Majesty, Harmony, Melody, Aria, Chorus, Carousel, Chandelier, Tiara, Diadem, Locket, Brooch, Pendant, Cameo, Medallion, Bouquet, Garland,
      Blossom, Orchid, Camellia, Jasmine, Gardenia, Magnolia, Wisteria, Hyacinth, Primrose, Bluebell, Snowdrop, Peony, Dahlia, Lotus, Aster, Azalea,
      Starlight, Moonlight, Sunrise, Sundown, Emissary, Ambassador`),
    star: words(`
      Morning Star, Evening Star, Sirius, Vega, Altair, Deneb, Rigel, Aldebaran, Antares, Arcturus, Canopus, Capella, Procyon, Spica, Pollux,
      Castor, Regulus, Fomalhaut, Achernar, Bellatrix, Mira, Polaris, Alnitak, Mintaka, Alnilam, Mizar, Alcor, Dubhe, Merak, Alioth, Electra, Maia,
      Taygeta, Alcyone, Celaeno, Sterope, Merope, Pleiades, Andromeda, Cassiopeia, Orion, Lyra, Cygnus, Aquila, Carina, Vela, Puppis, Columba,
      Phoenix, Pegasus, Draco, Hydra, Corona Borealis, Hyades, Sadr, Albireo, Shaula, Nunki, Hadar, Mimosa`),
    linerTitle: words(`Lady, Queen, Princess, Saint, Duchess, Countess, Empress, Dame`),
    phraseK: words(`Bon Voyage, Wish You Were Here, Grand Tour, Second Honeymoon, All Aboard, Window Seat, Captain's Table, Dinner at Eight`),
  },
};
const KIND_KEYS = Object.keys(KIND);

/** Liner companies by flag: "Valles Express Ascraeus". */
const LINES = {
  UN: words(`Luna Express, Earth-Belt Line, Lagrange Lines, Celestial Transit, Blue Planet Line, Copernicus Packet, Tranquility Line`),
  MCR: words(`Valles Express, Tharsis Line, Hellas Passenger, Ares Transit, Elysium Line, Phobos Packet, Olympus Lines`),
  OPA: words(`Ceres Express, Tycho Transit, Belt Passage, Pallas Packet, Eros Line, Vesta Ferry, Hygiea Lines`),
  IND: words(`Ganymede Line, Jovian Transit, Callisto Packet, Titan Express, Outer Reach Line, Free Passage, Saturn Ring Line`),
};

const CULT = {
  UN: { place: UN_PLACE, adjC: UN_ADJ, nounC: UN_NOUN, phraseC: UN_PHRASE, house: UN_HOUSE, line: LINES.UN },
  MCR: {
    place: MARS_PLACE, adjC: MARS_ADJ, nounC: MARS_NOUN, phraseC: MARS_PHRASE, kin: MARS_KIN, hopeAdj: MARS_HOPE_ADJ, hopeNoun: MARS_HOPE_NOUN,
    line: LINES.MCR,
  },
  OPA: {
    place: BELT_PLACE, adjC: BELT_ADJ, nounC: BELT_NOUN, phraseC: BELT_PHRASE, belA: BELTA_ADJ, belN: BELTA_NOUN, belKin: BELTA_KIN,
    line: LINES.OPA,
  },
  // Independents borrow from every culture.
  IND: {
    place: words([...OUTER_PLACE, ...UN_PLACE, ...MARS_PLACE, ...BELT_PLACE].join(',')),
    adjC: words([...IND_ADJ, ...UN_ADJ, ...MARS_ADJ, ...BELT_ADJ].join(',')),
    nounC: words([...UN_NOUN, ...MARS_NOUN, ...BELT_NOUN].join(',')),
    phraseC: TRADER_PHRASE, house: UN_HOUSE, line: LINES.IND,
  },
};

// ---- SUB-FACTION FLAVOR ----

const SUB_WORDS = {
  // Ganymede Agricultural Concord: the system's breadbasket.
  agAdj: words(`
    Golden, Ripe, Green, Bountiful, Fallow, Tender, Sprouting, Ripening, Fruitful, Fertile, Abundant, Lush, Verdant, Leafy, Hardy, Hybrid,
    Hydroponic, Aeroponic, Lamplit, Seasonal, Ample, Plentiful, Wholesome, Hearty, Heirloom, Sweet, Crisp, Juicy, Mirrorlit, Second-Crop`),
  agNoun: words(`
    Harvest, Orchard, Granary, Sheaf, Furrow, Barley, Millet, Sorghum, Soy, Rice, Wheat, Rye, Oat, Bean, Lentil, Potato, Yam, Cassava, Pumpkin,
    Squash, Apple, Fig, Olive, Plum, Mango, Papaya, Guava, Lychee, Persimmon, Pear, Quince, Apricot, Melon, Cabbage, Kale, Spinach, Lettuce, Tomato,
    Pepper, Chili, Onion, Garlic, Ginger, Basil, Mint, Thyme, Saffron, Vanilla, Cocoa, Coffee, Tea, Hops, Silo, Seedbank, Greenhouse, Trellis,
    Vineyard, Paddy, Pasture, Haystack, Beehive, Honeycomb`),
  // Vesta Miners' Cooperative: equal shares.
  coopAdj: words(`
    Common, Equal, Fair, Shared, Mutual, Honest, Joint, Collective, Cooperative, Pooled, United, Level, Even, Square, Open, Plain, Decent,
    Fraternal, Neighborly, Kindred`),
  coopNoun: words(`
    Share, Lode, Seam, Claim, Stake, Measure, Portion, Cut, Dividend, Fund, Pool, Purse, Ledger, Vote, Hand, Shift, Hall, Table, Bargain, Deal,
    Partner, Neighbor, Comrade, Member, Commons, Holding, Pit, Shaft, Drift, Gallery`),
  // The Belt unions.
  unionAdj: words(`
    Fair, Common, United, Equal, Shared, Honest, Mutual, Organized, Solid, Steady, Joint, Collective, Striking, Working, Living, Safe, Decent,
    Dignified, Bargaining, Militant, Rank-and-File, Card-Carrying, Dues-Paying, Eight-Hour`),
  unionNoun: words(`
    Shift, Wage, Share, Hand, Hall, Line, Fund, Vote, Contract, Bargain, Strike, Picket, Banner, Local, Card, Dues, Steward, Grievance, Walkout,
    Solidarity, Fellowship, Comrade, Worker, Laborer, Docker, Rigger, Welder, Fitter, Crew, Shop, Floor, Yard, Break, Holiday, Overtime`),
  unionPhrase: words(`
    Eight Hours, Fair Shift, Union Hall, One Big Union, Strike Fund, Picket Line, Shop Steward, Living Wage, Safe Air, Hazard Pay, Dues Paid,
    Card Carrier, Walkout, Sitdown, Bread and Roses, An Injury to All, Solidarity, Rank and File, Stop Work`),
  localNum: Array.from({ length: 499 }, (_, i) => String(i + 1)),
  // Tycho builds things that are square, true and level.
  tychoAdj: words(`
    True, Plumb, Square, Level, Tight, Trued, Balanced, Tempered, Annealed, Machined, Polished, Measured, Precise, Fine, Clean, Sound, Solid,
    Welded, Riveted, Forged, Cast, Milled, Honed, Calibrated, Shimmed`),
  tychoNoun: words(`
    Weld, Rivet, Spindle, Truss, Girder, Gantry, Caliper, Plumb, Level, Square, Torque, Gimbal, Bearing, Flange, Gasket, Sprocket, Ratchet, Lathe,
    Jig, Fixture, Bracket, Strut, Spar, Keel, Frame, Rib, Plate, Seam, Joint, Bolt, Washer, Shim, Gauge, Vernier, Micrometer, Blueprint, Drydock,
    Cradle, Crane, Construction`),
  // Ceres Free Belt: militants.
  militPhrase: words(`
    No More Inners, Free Belt, Nobody's Boot, Our Rocks, Beltalowda Stand, Never Kneel, Rock Throwers, Air Is Ours, Water Is Ours, Take It Back,
    Long Memory, Inyalowda Go Home, Belt for Belters, Last Rock Standing, Not Your Colony, Free Ceres, Sky Is Ours, Burn the Ledger, No Masters,
    Rocks Fall`),
  // Pur'n'Kleen water hauling, after the "Weeping Somnambulist".
  whimAdj: words(`
    Weeping, Dreaming, Wistful, Melancholy, Sleepy, Drowsy, Pensive, Bashful, Ponderous, Lumbering, Contemplative, Moonstruck, Lovesick,
    Absent-Minded, Reluctant, Dignified, Pious, Sorrowful, Bewildered, Serene, Placid, Mournful, Bemused, Befuddled, Perplexed, Sheepish, Penitent,
    Lugubrious, Lackadaisical, Indolent, Languid, Lethargic, Somnolent, Phlegmatic, Unflappable, Imperturbable, Courteous, Chivalrous, Obliging,
    Fastidious, Punctilious, Meticulous, Tremulous, Querulous, Garrulous, Loquacious, Taciturn, Rueful, Doleful, Woebegone, Forlorn, Plaintive,
    Hapless, Luckless`),
  whimNoun: words(`
    Somnambulist, Leviathan, Pachyderm, Dowager, Philosopher, Troubadour, Penitent, Pilgrim, Hermit, Mendicant, Sleepwalker, Daydreamer, Raconteur,
    Bishop, Archimandrite, Walrus, Manatee, Narwhal, Tortoise, Elephant, Behemoth, Dirigible, Glacier, Cloud, Aunt, Grandmother, Duchess, Monk,
    Poet, Sonneteer, Lamplighter, Librarian, Archivist, Curate, Deacon, Abbess, Sexton, Bellringer, Gondolier, Balloonist, Dugong, Sloth,
    Hippopotamus, Rhinoceros, Mastodon, Zeppelin, Teapot, Wardrobe, Armchair, Grandfather Clock, Bathysphere, Cauliflower, Dumpling, Pudding,
    Meringue, Crumpet, Accordionist, Tuba`),
};

// ---- NAVIES ----

/** UNN: people from every Earth culture (a few from the canon), places, virtues. */
const UN_PERSON = words(`
  Agatha King, Seung Un, Thomas Prince, Ravi, Kittur Chennamma, Okimbo, Nathan Hale, Xiaoling, Zheng He, Yi Sun-sin, Ibn Battuta, Mansa Musa,
  Sundiata, Menelik, Taytu, Nzinga, Yaa Asantewaa, Queen Amina, Lalibela, Mandela, Nkrumah, Nyerere, Lumumba, Kenyatta, Wangari Maathai, Kofi Annan,
  U Thant, Hammarskjold, Eleanor Roosevelt, Lincoln, Frederick Douglass, Harriet Tubman, Sojourner Truth, Bolivar, San Martin, O'Higgins,
  Juana Azurduy, Jose Marti, Toussaint Louverture, Benito Juarez, Tecumseh, Sequoyah, Ambedkar, Tagore, Rani Lakshmibai, Ashoka, Akbar, Shivaji,
  Ranjit Singh, Sun Yat-sen, Sakamoto Ryoma, Sejong, Saladin, Alfred, Charlemagne, Newton, Galileo, Copernicus, Kepler, Brahe, Herschel, Hubble,
  Henrietta Leavitt, Marie Curie, Lise Meitner, Emmy Noether, Ada Lovelace, Grace Hopper, Alan Turing, Ramanujan, Raman, Chandrasekhar,
  Satyendra Bose, Yukawa, Tsiolkovsky, Korolev, Gagarin, Tereshkova, Leonov, Armstrong, Sally Ride, Mae Jemison, Yang Liwei, Kalpana Chawla,
  Hypatia, Al-Khwarizmi, Ibn Sina, Al-Biruni, Ibn al-Haytham, Omar Khayyam, Ulugh Beg, Aryabhata, Brahmagupta, Zu Chongzhi, Shen Kuo, Zhang Heng,
  Archimedes, Eratosthenes, Hipparchus, Euclid, Darwin, Mendel, Pasteur, Fleming, Jonas Salk, Faraday, Maxwell, Tesla, Einstein, Niels Bohr,
  Max Planck, Dirac, Fermi, Feynman, Sagan, Hawking, Jane Goodall, Rachel Carson, Cousteau, Humboldt, Nansen, Amundsen, Shackleton, Magellan,
  Elcano, Cabral, James Cook, Bougainville, Bering, Matthew Henson, Tenzing Norgay, Edmund Hillary, Amelia Earhart, Bessie Coleman, Kupe, Tupaia,
  Mau Piailug, Nelson, De Ruyter, Tromp, Nimitz, Spruance, Farragut, Ushakov, Nakhimov, Cochrane, Miguel Grau, Arturo Prat, Tamandare,
  Almirante Brown, Kanhoji Angre, Kemal Reis, Piri Reis, Ahmad ibn Majid, Jellicoe, Cunningham, Tegetthoff, Andrea Doria, Jeanne d'Arc, Nightingale,
  Mary Seacole, Rosalind Franklin, Katherine Johnson, Chien-Shiung Wu, Tu Youyou, Maryam Mirzakhani, Vera Rubin, Cecilia Payne, Caroline Herschel,
  Mary Somerville, Sophie Germain`);
/** The grand places, for capital ships: "UNN Kilimanjaro". */
const UN_GRAND = words(`
  Kilimanjaro, Annapurna, Denali, Aconcagua, Kangchenjunga, Elbrus, Matterhorn, Mont Blanc, Fuji, Kailash, Chimborazo, Cotopaxi, Ararat, Erebus,
  Krakatoa, Vesuvius, Etna, Mauna Kea, Ruwenzori, Drakensberg, Karakoram, Hindu Kush, Tian Shan, Altai, Zagros, Himalaya, Andes, Alps, Urals,
  Caucasus, Pyrenees, Appalachia, Sierra Madre, Pacific, Atlantic, Indian Ocean, Arctic, Antarctica, Southern Ocean, Caribbean, Mediterranean,
  Coral Sea, Tasman Sea, Bering Sea, Sargasso, Sahara, Gobi, Atacama, Kalahari, Namib, Siberia, Amazon, Serengeti, Okavango, Mekong, Yangtze,
  Ganges, Nile, Congo, Zambezi, Volga, Mississippi, Orinoco, Indus, Euphrates, Tigris, Niagara, Iguazu, Gibraltar, Good Hope, Cape Horn, Terra Nova,
  Aravalli, Earth, Luna, Terra, Gaia`);
const VIRTUE = words(`
  Resolute, Valiant, Endurance, Fortitude, Vigilance, Constancy, Perseverance, Temperance, Prudence, Justice, Liberty, Concord, Unity, Integrity,
  Honor, Fidelity, Courage, Steadfast, Intrepid, Indomitable, Implacable, Relentless, Defiance, Dauntless, Audacious, Tenacity, Resolve, Sovereign,
  Guardian, Sentinel, Covenant, Accord, Amity, Solidarity, Mercy, Equity, Valor, Gallant, Stalwart, Undaunted, Unwavering, Unbroken, Enduring,
  Faithful, Truth, Wisdom, Providence, Hope, Harmony, Peace, Triumph, Victory, Glory, Majesty, Ascendant, Paramount, Magnanimous, Benevolent,
  Inexorable, Formidable, Redoubtable, Unyielding, Invincible, Impregnable, Illustrious, Venerable, Fellowship, Humanity, Commonwealth`);
const NAVY_RANK = words(`Admiral, General, Commodore, Marshal, Secretary-General`);
const NAVY_OF = words(`
  Pride, Shield, Spirit, Sword, Light, Voice, Star, Defender, Sentinel, Keeper, Guardian, Glory, Heart, Hammer, Lance, Banner, Wrath, Fury, Hope`);

/** MCRN: Martian geography, founders, winds and weapons, the war names of Greece and Rome. */
const MARS_FOUNDER = words(`
  Xuesen, Barkeith, Gelan, Dewalt, Okonjo, Halloran, Abernathy, Dzhamilov, Ostrovsky, Achterberg, Mbatha, Quintero, Kessler, Arkwright, Brennan,
  Castellanos, Delacorte, Ekwueme, Falconer, Gaskell, Hakimian, Imbert, Jovanovich, Laszlo, Nakashima, Oyelaran, Pradhan, Qiao, Rostova, Sandoval,
  Takeda, Umarov, Valcourt, Wexley, Yamazaki, Zharkov, Ashgrove, Brightwater, Coldwell, Dunmore, Everhart, Fairbank, Greenhalgh, Holbrook, Ironside,
  Jessup, Kingsley, Lockhart, Marlow, Northcott, Oakhurst, Pennington, Redfield, Stonebridge, Thorne, Underhill, Vance, Whitcombe, Yardley, Bello,
  Chukwu, Danso, Eze, Fofana, Gakuru, Hamid, Idowu, Jalloh, Kamara, Lungu, Tsiolkova, Varga, Szilard, Oberth, Zubrin, Von Braun, Tsander,
  Kondratyuk, Esnault, Goddard, Valier, Noordung, Ley`);
const MARS_WIND = words(`
  Scirocco, Mistral, Khamsin, Simoom, Harmattan, Bora, Haboob, Chinook, Foehn, Levante, Tramontane, Zonda, Pampero, Williwaw, Shamal, Etesian,
  Buran, Karaburan, Sukhovei, Bise, Gregale, Libeccio, Ostro, Meltemi, Santa Ana, Brickfielder, Purga, Calima, Leveche, Vardar, Kosava, Matanuska,
  Taku, Papagayo, Zephyr, Boreas, Notus, Eurus, Aeolus, Squall, Tempest, Cyclone, Typhoon, Dust Storm`);
const MARS_WEAPON = words(`
  Gladius, Pilum, Spatha, Falcata, Sarissa, Xiphos, Kopis, Dory, Aspis, Scutum, Hoplon, Ballista, Onager, Scorpio, Trebuchet, Mangonel, Halberd,
  Glaive, Partisan, Claymore, Saber, Rapier, Tachi, Naginata, Kris, Kukri, Tulwar, Shamshir, Yatagan, Assegai, Khopesh, Lance, Javelin, Harpoon,
  Trident, Flail, Morningstar, Warhammer, Broadsword, Longbow, Crossbow, Arbalest, Catapult, Petard, Culverin, Carronade, Bombard, Falconet, Raptor,
  Hellion, Lancer, Hussar, Dragoon, Cuirassier, Grenadier, Fusilier, Ranger`);
const MARS_WAR = words(`
  Leonidas, Themistocles, Miltiades, Epaminondas, Pelopidas, Brasidas, Xenophon, Pericles, Agrippa, Scipio, Camillus, Cincinnatus, Fabius, Regulus,
  Horatius, Germanicus, Belisarius, Aurelian, Trajan, Hadrian, Vespasian, Marius, Hannibal, Hamilcar, Achilles, Hector, Ajax, Diomedes, Odysseus,
  Patroclus, Penthesilea, Hippolyta, Bellona, Enyo, Nike, Athena, Pallas Athene, Mars Ultor, Polemos, Alala, Enyalios, Phalanx, Centurion,
  Praetorian, Legionary, Triarius, Strategos, Polemarch, Navarch, Trierarch, Hipparch, Tribune, Legate, Decurion, Aquilifer, Signifer, Testudo,
  Boudica, Vercingetorix, Arminius, Spartacus, Artemisia, Telesilla, Zenobia, Tomyris, Donnager`);
const MARS_LAWGIVER = words(`
  Hammurabi, Sargon, Gilgamesh, Ur-Nammu, Solon, Lycurgus, Cyrus, Darius, Draco, Numa, Justinian, Urukagina, Lipit-Ishtar, Ashurbanipal,
  Nebuchadnezzar, Ramesses, Thutmose, Hatshepsut, Senusret, Djoser, Imhotep, Narmer, Esarhaddon, Tiglath-Pileser, Cleisthenes`);
const MARTIAL = words(`
  Hammer, Lance, Spear, Shield, Sword, Fist, Storm, Thunder, Fury, Wrath, Vigil, Bastion, Bulwark, Rampart, Citadel, Anvil, Arrow, Javelin, Talon,
  Fang, Claw, Herald, Sentinel, Warden, Guardian, Champion, Reckoning, Judgment, Verdict, Resolve, Defiance, Valor, Honor, Duty, Glory, Tempest,
  Lightning, Gauntlet, Aegis, Spearhead, Vanguard, Edge, Blade, Shadow, Flame, Ember, Bolt, Spike`);

/** OPA warships: Belter heroes and Belter anger, no prefix. */
const OPA_MA = words(`
  Free, Iron, Black, Last, Long, Proud, Defiant, Unbowed, Unbroken, Stubborn, Dawn, Rock, Dust, Spin, Hard, Cold, Burning, Angry, Righteous, Loyal,
  Outer, Deep, Far, Patient, Silent, Wild, Tight, Red, Rising, Roaring, Howling, Thundering, Shattering, Breaking, Belt, Bitter, Unpaid, Hungry,
  Remembered, Avenging`);
const OPA_MN = words(`
  Belt, Fist, Hammer, Anvil, Wrench, Spanner, Torch, Spear, Shield, Wall, Line, Stand, Answer, Reply, Voice, Word, Promise, Oath, Vow, Debt, Due,
  Reckoning, Uprising, Rising, Revolt, Defiance, Liberty, Freedom, Union, Kin, Clan, Brother, Sister, Mother, Ghost, Dawn, Storm, Gale, Tide, Comet,
  Meteor, Avalanche, Landslide, Rockfall, Hailstorm, Slingshot, Mass Driver, Breaker, Crowbar, Knuckle, Grudge, Memory, Ledger, Bill, Toll`);
const OPA_HERO = words(`Guy Molinari, Connaught, Behemoth Ghost, Lady Kali, Dawn Bringer, Free Belt, Tycho's Answer, Ceres Remembers`);

/** Hull codes for a navy's fallback number: "UNN Ravi (FFG-214)". */
const HULL = { corvette: 'PC', frigate: 'FFG', destroyer: 'DDG', battleship: 'BB', gunship: 'PG', cutter: 'WPC', raider: 'PR' };

// ---- POLICE ----

const POLICE_VIRTUE = words(`
  Vigilant, Steadfast, Constant, Watchful, Wary, Alert, Diligent, Dutiful, Faithful, Resolute, Stalwart, Sentinel, Warden, Sentry, Guardian, Keeper,
  Bulwark, Bastion, Rampart, Aegis, Shield, Lantern, Beacon, Lamplight, Vigil, Patience, Prudence, Probity, Integrity, Rectitude, Justice, Equity,
  Order, Concord, Temperance, Fortitude, Honor, Oath, Pledge, Covenant, Statute, Writ, Warrant, Mandate, Edict, Charter, Precept, Ordinance,
  Verdict, Tribune, Marshal, Constable, Bailiff, Magistrate, Assessor, Inspector, Auditor, Arbiter, Herald, Steward, Custodian, Protector, Defender,
  Ranger, Outrider, Picket, Lookout, Watchman, Nightwatch, Searchlight, Cordon, Checkpoint, Barrier, Gatekeeper, Anchor, Plumb Line, Due Process,
  Probable Cause`);
const WATCH_ADJ = words(`
  Constant, Steady, Silent, Patient, Sleepless, Unblinking, Iron, Long, Quiet, Close, Careful, Unsleeping, Faithful, Lawful, Honest, Even, Fair,
  Stern, Firm, Clear, Keen, Sharp, Open, Wakeful, Ready, True, Upright, Plain, Level, Straight, Watchful, Vigilant`);
const WATCH_NOUN = words(`
  Watch, Vigil, Guard, Warden, Sentry, Keeper, Lantern, Eye, Hand, Shield, Line, Ward, Gate, Beacon, Patrol, Picket, Lookout, Witness, Measure,
  Rule, Law, Oath, Word, Promise, Scale, Balance, Sentinel, Marshal`);
/** What a place keeps: "SH Ceres Watch". */
const WATCH_POST = words(`
  Watch, Patrol, Guard, Picket, Lookout, Sentry, Warden, Ward, Gate, Line, Beacon, Lantern, Sentinel, Marshal, Vigil, Keeper`);
const NUMS = Array.from({ length: 98 }, (_, i) => String(i + 2));

// ---- PIRATES ----
// Each clan names to its legend. `cA cN` is the clan's own cross-product,
// `cHead of cOf` its grand style, `cPhrase` its set pieces.

const CLAN = {
  'clan-rust': {
    cA: words(`
      Rust, Rusted, Rusty, Iron, Oxide, Corroded, Scrap, Pitted, Flaking, Red, Tarnished, Brass, Copper, Verdigris, Crumbling, Salvaged, Welded,
      Riveted, Jagged, Bent, Patchwork, Scavenged, Stolen, Crooked, Broken, Gilded, Rotten, Tin, Pewter, Leaden, Junkyard, Scrapyard, Seized,
      Squealing`),
    cN: words(`
      Queen, Crown, Throne, Scepter, Empress, Duchess, Majesty, Court, Regent, Tiara, Dowager, Matriarch, Sovereign, Countess, Baroness, Princess,
      Monarch, Highness, Grace, Ladyship, Mother, Widow, Bride, Consort, Heiress, Diadem, Coronet, Jewel, Chalice, Orb, Mantle, Signet, Seal,
      Banner, Palace, Keep, Fortress, Tower, Hoard`),
    cHead: words(`Queen, Crown, Throne, Empress, Duchess, Bride, Widow, Court, Scepter, Tithe, Toll, Mercy, Favor, Decree`),
    cOf: words(`
      Rust, Scrap, Nails, Rivets, Iron, Wrecks, Ruin, Salvage, Bolts, Chains, Shrapnel, Slag, Wire, Cinders, Ashes, Bones, Debts, Junk, Old Hulls,
      Broken Things`),
    cPhrase: words(`
      Rust Queen, Her Rusted Majesty, Long Live the Queen, Queen's Ransom, Crown Tax, Iron Tithe, Royal Pardon, Bow Before Rust, The Queen Decides,
      Kneel and Pay, Scrap Royalty, Rust Never Sleeps`),
  },
  'clan-dark': {
    cA: words(`
      Hungry, Starving, Empty, Black, Lightless, Endless, Silent, Cold, Gnawing, Famished, Ravenous, Bottomless, Lean, Hollow, Dark, Deep, Starless,
      Moonless, Sunless, Blind, Unseen, Creeping, Lurking, Waiting, Patient, Devouring, Swallowing, Yawning, Gaping, Howling, Grinning, Insatiable,
      Greedy, Cruel`),
    cN: words(`
      Dark, Night, Void, Maw, Belly, Mouth, Gullet, Abyss, Hunger, Feast, Appetite, Throat, Pit, Eclipse, Midnight, Shadow, Gloom, Murk, Shade,
      Dusk, Nothing, Silence, Chasm, Deep, Hole, Tooth, Fang, Jaw, Tongue, Teeth, Glutton, Wolf, Jackal, Hyena, Vulture, Shark, Lamprey, Leech, Eel,
      Moray, Viper, Adder, Spider, Mantis, Owl, Bat, Moth, Crow, Raven, Rook`),
    cHead: words(`Mouth, Belly, Hunger, Teeth, Throat, Feast, Gullet, Maw, Child, Hand, Eye, Appetite, Supper`),
    cOf: words(`Night, Hunger, Nothing, Silence, the Deep, the Void, Shadows, the Dark, Empty Places, Long Nights, Cold Stars, the Gap`),
    cPhrase: words(`
      Hungry Dark, Black Sky, Empty Belly, Night Feeds, Always Hungry, Lights Out, Nobody Home, Eat the Light, Dinner Time, Bring a Plate,
      Second Helping, Lick the Plate, Grace Before Meat, Starve the Stars`),
  },
  'clan-knives': {
    cA: words(`
      Winter, Autumn, Harvest, Spring, Summer, Fall, Frost, Thaw, Reaping, Sowing, Solstice, Equinox, Monsoon, Drought, Midwinter, Midsummer, Dry,
      Wet, Hunting, Culling, Killing, Lean, Hungry, Sharp, Keen, Honed, Whetted, Bright, Cold, Quick, Silent, Red`),
    cN: words(`
      Knife, Blade, Edge, Razor, Scythe, Sickle, Dagger, Shiv, Stiletto, Cleaver, Hook, Machete, Kris, Kukri, Whetstone, Cut, Point, Steel, Shank,
      Dirk, Bodkin, Lancet, Scalpel, Switchblade, Glaive, Billhook, Pruner, Thresher, Reaper, Harvester, Gleaner, Season, Harvest, Reaping`),
    cHead: words(`Season, Time, Month, Year, Harvest, Feast, Festival, Holiday, Hour, Week, Moon, Day, Dance, Song`),
    cOf: words(`
      Knives, Blades, Edges, Razors, Scythes, Sickles, Daggers, Hooks, Cleavers, Points, Shivs, Reaping, Short Straws, Red Hands, Sharp Things`),
    cPhrase: words(`
      Knife Season, Last Harvest, Reaping Time, Scythe Moon, Cut and Run, Sharp Practice, Close Shave, Clean Cut, Short Straw, Blunt Answer,
      Twist the Knife, Whetstone Song, Paring Knife, Pruning Time`),
  },
  'clan-ghost': {
    cA: words(`
      Ghost, Pale, Silent, Quiet, Forgotten, Nameless, Unmarked, Lost, Hollow, Faded, Whispering, Absent, Vanished, Drifting, Unremembered, Missing,
      Grey, Dim, Faint, Mute, Hushed, Veiled, Shrouded, Hidden, Masked, Unlisted, Unregistered, Derelict, Abandoned, Orphaned, Buried, Sunken,
      Drowned, Restless, Wandering, Weeping`),
    cN: words(`
      Drift, Signal, Grave, Wake, Echo, Shroud, Lantern, Hand, Name, Witness, Passenger, Beacon, Return, Voice, Shade, Wraith, Specter, Phantom,
      Spirit, Haunt, Revenant, Banshee, Apparition, Mourner, Widow, Orphan, Stranger, Visitor, Caller, Guest, Lodger, Tenant, Rumor, Whisper, Sigh,
      Hush, Silence, Ash, Mist, Fog, Haze, Smoke, Veil, Mask, Footstep, Knock, Epitaph, Eulogy, Requiem, Dirge, Wreath, Candle, Bones`),
    cHead: words(`Ghost, Shade, Echo, Widow, Child, Voice, Hand, Grave, Song, Keeper, Lantern, Wake`),
    cOf: words(`
      Nobody, the Lost, Silence, Forgotten Ships, Old Wrecks, the Missing, No Name, Empty Lanes, Dead Air, Dark Transponders, Unmarked Graves`),
    cPhrase: words(`
      Ghost Belt, No Return, Dead Reckoning, Nobody's Child, Not Really Here, Never Was, Who Goes There, Knock Knock, You Saw Nothing, No Such Ship,
      Missing Presumed, Lost With All Hands, Return to Nowhere, Transponder Off`),
  },
};
const CLAN_IDS = Object.keys(CLAN);
const PIRATE = {
  nick: words(`
    Mad, Black, Red, One-Eyed, Old, Lucky, Grinning, Silent, Smiling, Long, Little, Bad, Dirty, Crooked, Handsome, Gentleman, Lady, Mother, Saint,
    Iron, Cold, Quiet, Mean, Sweet, Pretty, Ugly, Tall, Sad, Laughing, Honest, Gentle, Hungry, Three-Finger, Whistling`),
  pThing: words(`
    Revenge, Due, Toll, Share, Cut, Prize, Grudge, Reward, Wages, Debt, Answer, Bargain, Dowry, Inheritance, Pension, Retirement, Tax, Tithe, Fee,
    Ransom, Insurance, Gift, Tip, Bonus, Commission, Leftovers, Supper, Bounty, Trophy, Souvenir, Keepsake, Welcome, Surprise`),
  pAdj: words(`
    Black, Red, Grim, Cruel, Cold, Savage, Wicked, Vicious, Feral, Rabid, Mean, Nasty, Crooked, Twisted, Rotten, Bitter, Sour, Jagged, Ragged,
    Rusty, Dirty, Filthy, Greedy, Bad, Wrong, Lawless, Godless, Shameless, Ruthless, Merciless, Heartless, Reckless, Restless, Wolfish, Desperate`),
  pNoun: words(`
    Sky, Saint, Tide, King, Debt, Reckoning, Return, Wolf, Jackal, Hyena, Vulture, Buzzard, Crow, Raven, Shark, Barracuda, Piranha, Viper, Cobra,
    Scorpion, Hornet, Wasp, Rat, Weasel, Ferret, Stoat, Mongrel, Cur, Hound, Dog, Fox, Bandit, Brigand, Corsair, Buccaneer, Reaver, Marauder,
    Raider, Rover, Outlaw, Renegade, Rogue, Scoundrel, Villain, Devil, Fiend, Ghoul, Grin, Smile, Laugh, Promise, Threat, Bargain, Offer, Welcome`),
  ironic: words(`
    Bad Debt, Gutter Saint, Low Tide, Scavenger King, Finders Keepers, Toll Collector, Tax Man, Customs Inspector, Good Samaritan, Mercy Mission,
    Honest Mistake, Humanitarian Aid, Courtesy Call, Your Problem Now, Insurance Claim, Fair Share, Small Fee, Wealth Redistribution, Spare Change,
    Pay the Toll, Hands Up, Easy Money, Nothing Personal, Business Is Business, Polite Request, Gentle Persuasion, Free Sample, Clearance Sale,
    Under New Management, Lost and Found, Search and Rescue, Neighborhood Watch, Friendly Neighbor, Welcome Committee, Last Warning,
    No Hard Feelings, Terms and Conditions, Thank You Kindly`),
  // Lang Belta for thieves and big bosses: "Kowmang Jackal", "Xidawang Throne".
  belPir: words(`Kowmang, Sabaka, Xidawang, Nating`),
};

// ---- MERCENARIES ----
// Brannock Security Services names its armed hulls like invoices.

const HARD_ADJ = words(`
  Hard, Cold, Iron, Grim, Clean, Final, Silent, Bitter, Blunt, Sharp, Swift, Certain, Due, Lawful, Measured, Proportionate, Reasonable,
  Professional, Contracted, Licensed, Bonded, Discreet, Deniable, Plausible, Prompt, Efficient, Thorough, Decisive, Overwhelming, Surgical, Kinetic,
  Terminal, Absolute, Executive, Hostile, Binding, Prepaid, Itemized`);
const HARD_NOUN = words(`
  Verdict, Invoice, Contract, Retainer, Settlement, Clause, Remedy, Argument, Persuasion, Answer, Collateral, Deterrent, Margin, Dividend,
  Liability, Guarantee, Assurance, Warrant, Mandate, Solution, Resolution, Outcome, Option, Measure, Response, Reply, Courtesy, Discretion,
  Diligence, Instrument, Asset, Provision, Audit, Review, Termination, Severance, Escalation, Leverage, Incentive, Notice`);

// ---- PATTERNS ----
// [weight, template]. `{a}` draws one word from list `a` of the pool's
// context; `{a|b}` from a and b together. Weights are relative within a
// pool: the base civilian patterns weigh about 820, and the culture's,
// trade's and sub-faction's are added on top.
//
// The budget: a pattern drawn d times from a space of S names repeats
// itself about d²/2S times. So a small space gets a small weight (a fixed
// phrase list a few per mille at most), and a space that many pools share
// (everyone's "{given} {family}", a culture's "{adjC} {nounC}") is charged
// for all of their draws. The three-word compositions ("Lucky Strike of
// Gaspra", "Old Halvorsen's Pick") carry the weight.

const CIVIL_PATTERNS = [
  // The trade's own words, alone and with the culture's: "Lusaka Finder", "Dome Runner", "Bounding Memo of Valparaíso".
  [20, '{adjK} {nounK}'], [6, 'The {adjK} {nounK}'], [45, '{adjC} {nounK}'], [60, '{place} {nounK}'], [50, '{nounC} {nounK}'],
  [25, '{adjK} {nounC}'], [20, '{adj} {nounK}'], [100, '{adjK} {nounK} of {place}'], [50, '{adjC} {nounK} of {place}'],
  [6, '{nounK} of {abstract}'], [8, '{adjK} {nounK} of {abstract}'],
  // The culture's words: "Golden Rose of Lagos", "Postcard from Pallas".
  [12, '{adjC} {nounC}'], [20, '{place} {nounC}'], [15, '{adj} {nounC}'], [8, '{ofHead} of {place}'],
  [60, '{adj} {ofHead} of {place}'], [35, '{posAdj} {ofHead} of {place}'], [12, '{going} {goingObj|place}'],
  // People, and what they own: "Auntie Mabel's Folly", "Halvorsen's Last Strike".
  [30, '{given} {family}'], [25, '{titleFull} {given} {family}'], [4, '{title} {family}'], [3, '{title} {given}'],
  [8, "{given}'s {thing}"], [8, "{family}'s {thing}"], [30, "{given}'s {posAdj} {thing}"], [20, "{family}'s {posAdj} {thing}"],
  [25, "{title} {given}'s {thing}"], [40, "{family}'s {posAdj} {nounK}"], [20, "{given}'s {nounK}"], [20, "{family}'s {nounK}"],
  [30, "{title} {family}'s {nounK}"],
  // Seasoning.
  [1.5, '{ofHead} of {abstract}'], [0.6, '{phrase}'], [0.4, '{phraseK}'], [0.4, '{phraseC}'],
];

/** Workboats are often just numbered: "Pallas Lighter 14". */
const KIND_PATTERNS = {
  shuttle: [[60, '{place} {nounK} {num}']],
  barge: [[25, '{place} {nounK} {num}']],
};

const CULTURE_PATTERNS = {
  // "Kepler Bright", "Mercator Golden Promise".
  UN: [[18, '{house} {adjC|nounC}'], [15, '{house} {nounK}'], [30, '{house} {adjC} {nounC}']],
  // "Daughter of Hellas", "Child of Second Spring".
  MCR: [
    [15, '{kin} of {place}'], [10, '{place} {kin}'], [50, '{kin} of {hopeAdj} {hopeNoun}'],
    [12, '{kin} of the {hopeAdj} {hopeNoun}'], [8, '{adjC} {kin}'],
  ],
  // "Sabaka Dust", "Mi Rusty Tether", "Oye Bosmang Mabel", "Ice Wa Pallas", "Beratna Amara Okafor".
  OPA: [
    [10, '{belA} {nounC|nounK}'], [15, '{belA} {nounC} {nounK}'], [10, '{belA} {adjC} {nounK}'], [8, '{adjC|adjK} {belN}'],
    [35, 'Mi {adjC|adjK} {nounC|nounK}'], [2.5, 'Mi {belN|nounC|nounK}'], [2, 'To {belN|nounC|nounK}'],
    [15, 'Oye {belKin|title} {given}'], [8, '{belKin} {given|place|nounC}'], [2, 'Ke {nounC|nounK} Tu'],
    [25, '{nounC|nounK} Wa {place}'], [10, "{given}'s {belKin|belN}"], [20, '{belKin} {given} {family}'],
  ],
  // "Fourth Mortgage", "Halvorsen's Third Loan", "Uncle Jonah's Overdraft", "Not Insured".
  IND: [
    [3, '{ordinal} {ordNoun}'], [5, '{debtAdj} {debtNoun}'], [15, "{given}'s {debtNoun}"], [50, "{family}'s {ordinal} {ordNoun}"],
    [40, "{title} {given}'s {debtNoun}"], [0.5, 'Not {notX}'], [0.5, 'Never {neverX}'], [15, '{indAdj} {nounK|nounC}'],
    [20, '{debtAdj} {nounK}'],
  ],
};

/** "Ceres Express Morning Pearl", "Valles Express Ascraeus", "Silver Swan of Lagos". */
const LINER_PATTERNS = [
  [180, '{line} {adjK} {nounK}'], [5, '{line} {star}'], [10, '{line} {place}'], [100, '{line} {adjK} {star}'],
  [60, '{line} {linerTitle} {given}'], [20, '{adjK} {nounK}'], [200, '{adjK} {nounK} of {place}'], [50, '{nounK} of {place}'],
  [50, '{place} {nounK}'], [20, '{ofHead} of {place}'], [8, '{linerTitle} of {place}'], [50, '{titleFull} {given} {family}'],
];

/** Sub-faction flavor, added to the culture's pool (which weighs about 900). */
const SUB_PATTERNS = {
  'ind-ganymede': [
    [10, '{agAdj} {agNoun}'], [30, '{place} {agNoun}'], [20, "{given}'s {agNoun}"], [15, '{agAdj} {nounK}'],
    [2, 'Ganymede {agNoun|nounK}'], [30, '{agAdj} {agNoun} of {place}'],
  ],
  'ind-vesta': [
    [12, '{coopAdj} {coopNoun|nounK}'], [3, 'Vesta {nounK|nounC}'], [15, "{family}'s {coopNoun}"], [15, '{coopAdj} {nounC}'],
    [20, '{coopAdj} {nounK} of {place}'],
  ],
  'ind-traders': [
    [3, '{ordinal} {ordNoun}'], [5, '{debtAdj} {debtNoun}'], [20, "{given}'s {debtNoun}"], [60, "{family}'s {ordinal} {ordNoun}"],
    [50, "{title} {given}'s {debtNoun}"], [1, 'Not {notX}'], [1, 'Never {neverX}'], [1, '{phraseC}'], [25, '{debtAdj} {nounK}'],
  ],
  'opa-unions': [
    [10, '{unionAdj} {unionNoun}'], [30, '{unionAdj} {nounC|nounK}'], [1, '{unionPhrase}'], [3, 'Local {localNum}'],
    [20, '{place} {unionNoun}'], [20, "{given}'s {unionAdj} {unionNoun}"],
  ],
  'opa-tycho': [
    [10, '{tychoAdj} {tychoNoun}'], [3, 'Tycho {tychoNoun|nounC|nounK}'], [20, '{tychoAdj} {nounK}'], [15, '{tychoAdj} {nounC}'],
    [20, "{family}'s {tychoNoun}"], [15, '{tychoAdj} {tychoNoun} of {place}'],
  ],
  'opa-ceres': [[12, '{opaMA} {opaMN}'], [20, '{place} {opaMN}'], [0.5, '{militPhrase}'], [15, '{opaMA} {nounK}'], [15, '{opaMN} of {place}']],
};

/** Pur'n'Kleen water haulers and tankers: "Pur'n'Kleen Weeping Somnambulist", most of the time. */
const WATER_PATTERNS = [[150, "Pur'n'Kleen {whimAdj} {whimNoun}"], [40, "Pur'n'Kleen {whimAdj} {nounK}"], [40, "Pur'n'Kleen {whimNoun} of {place}"]];
const WATER_SHARE = 0.6;

// Navies, police and pirates field hundreds of hulls, not tens of
// thousands: their famous single names carry real weight, and the
// registry numbers whatever repeats.
const NAVY_PATTERNS = {
  UN: {
    light: [
      [8, '{unPerson}'], [34, '{given} {family}'], [8, '{unPlace}'], [3, '{unGrand}'], [3, '{virtue}'], [10, '{rank} {family}'],
      [8, '{navyOf} of {unPlace}'], [12, '{rank} {given} {family}'],
    ],
    capital: [
      [14, '{unPerson}'], [8, '{virtue}'], [8, '{unGrand}'], [18, '{navyOf} of {unGrand|unPlace}'], [8, '{navyOf} of {virtue}'],
      [14, '{given} {family}'], [12, '{rank} {family}'], [10, '{rank} {given} {family}'],
    ],
  },
  MCR: {
    light: [
      [8, '{marsPlace}'], [6, '{founder}'], [5, '{wind}'], [6, '{weapon}'], [6, '{war}'], [26, '{marsPlace} {martial}'],
      [16, '{given} {founder}'], [3, '{lawgiver}'], [14, '{martial} of {marsPlace}'],
    ],
    capital: [
      [12, '{war}'], [8, '{marsPlace}'], [26, '{martial} of {marsPlace}'], [6, '{lawgiver}'], [8, '{founder}'], [5, '{wind}'],
      [16, '{marsPlace} {martial}'], [10, '{given} {founder}'],
    ],
  },
};
const CAPITAL = new Set(['destroyer', 'battleship']);

const OPA_NAVY_PATTERNS = [
  [24, '{given} {family}'], [18, '{opaMA} {opaMN}'], [16, '{place} {opaMN}'], [8, '{belA} {opaMN}'],
  [12, '{opaMN} of {place}'], [10, "{family}'s {opaMN}"], [1, '{opaHero}'], [10, '{belKin} {given} {family}'],
];

const POLICE_PATTERNS = [
  [18, '{P} {pvirtue}'], [18, '{P} {watchAdj} {watchNoun}'], [30, '{P} {pvirtue} {num}'],
  [24, '{P} {watchAdj} {watchNoun} {num}'], [10, '{P} {place} {watchPost}'],
];

const PIRATE_PATTERNS = [
  [30, '{cA} {cN}'], [12, '{cHead} of {cOf}'], [1, '{cPhrase}'], [14, "{nick} {given}'s {pThing}"],
  [10, '{pAdj} {pNoun}'], [1, '{ironic}'], [6, '{belPir} {cN|pNoun}'], [4, 'The {cA} {cN}'], [6, '{cA} {pNoun}'],
];

const MERC_PATTERNS = [
  [25, '{hardAdj} {hardNoun}'], [15, "{family}'s {hardNoun}"], [15, '{hardAdj} {martial}'],
  [30, "{family}'s {hardAdj} {hardNoun}"], [15, "{title} {family}'s {hardNoun}"],
];

// ---- WHO GETS WHICH POOL ----

const NAMES_OF_KIND = {
  prospector: 'prospector', courier: 'courier', shuttle: 'shuttle', 'light-freighter': 'freighter', freighter: 'freighter',
  hauler: 'hauler', tanker: 'tanker', liner: 'liner', miner: 'barge', cutter: 'police', corvette: 'navy', frigate: 'navy',
  destroyer: 'navy', battleship: 'navy', gunship: 'navy', raider: 'pirate',
};
const CATEGORY_OF_NAMES = { police: 'authority', navy: 'military', opa: 'military', pirate: 'irregular' };
const CULTURE_OF = { UN: 'UN', MCR: 'MCR', OPA: 'OPA', independent: 'IND' };
/** Corporate codes, carried by about 40% of the corporation's big hulls. */
const CORP = { 'un-corp': 'LKC', 'mcr-corp': 'HAD', 'ind-ganymede': 'GAC', 'ind-merc': 'BSS' };
const CORP_SHARE = 0.4;
const CORP_SKIP = /'s |\{title|\{given|\{house|\{phrase|\{debt|\{ordinal|\{notX|\{neverX|\{going|\{bel/;
const BIG = new Set(['freighter', 'tanker', 'hauler', 'liner']);
export const NAVY_PREFIX = { UN: 'UNN', MCR: 'MCRN' };
const POLICE_PREFIX = { UN: 'UNS', MCR: 'MSS', OPA: 'SH', independent: 'Patrol' };
const POLICE_SUB = { 'un-security': 'UNS', 'mcr-security': 'MSS', 'opa-starhelix': 'SH', 'ind-merc': 'BSS' };
/** Intelligence hulls fly under plain civilian names; a warship kind borrows a trade's words. */
const INTEL = new Set(['un-intel', 'mcr-intel']);
const INTEL_KEY = {
  corvette: 'courier', cutter: 'courier', raider: 'courier',
  frigate: 'freighter', destroyer: 'freighter', battleship: 'freighter', gunship: 'freighter',
};

/** A rare numeral on a civilian name ("Tycho Dawn III"): rare, so it doesn't read as a fallback. */
const RARE_NUMERAL = 0.025;
const NUMERALS = ['II', 'II', 'II', 'III', 'III', 'IV', 'V', 'VI', 'VII'];
/** A numeral follows a thing's name, not a person's, a phrase's or a number. */
const NO_NUMERAL = new Set([
  'given', 'family', 'title', 'titleFull', 'belKin', 'phrase', 'phraseK', 'phraseC', 'unionPhrase', 'militPhrase', 'going', 'num',
  'localNum', 'ordinal', 'notX', 'neverX',
]);
const NO_NUMERAL_TEXT = / of |'s |^(Not|Never|Oye|Ke|To) | Wa /;

// ---- COMPILING POOLS ----

const SHARED = {
  given: GIVEN, family: FAMILY, title: TITLE, titleFull: TITLE_FULL, adj: ADJ, thing: THING, posAdj: POS_ADJ, ofHead: OF_HEAD,
  abstract: ABSTRACT, phrase: PHRASE, going: GOING, goingObj: GOING_OBJ, num: NUMS, ordinal: ORDINAL, ordNoun: ORD_NOUN,
  debtAdj: DEBT_ADJ, debtNoun: DEBT_NOUN, notX: NOT_X, neverX: NEVER_X, indAdj: IND_ADJ, martial: MARTIAL, opaMA: OPA_MA, opaMN: OPA_MN,
  ...SUB_WORDS,
};

const POOLS = new Map();

/** A compiled pool, built once per key (compiling draws nothing from the RNG). */
function pool(key, build) {
  let p = POOLS.get(key);
  if (!p) {
    const [patterns, ctx] = build();
    p = compile(patterns, ctx, key);
    POOLS.set(key, p);
  }
  return p;
}

// Pools share their word lists: a slot of one list uses that list, and a
// union (`{a|b}`) is built once for every pool that names the same lists.
const LIST_ID = new WeakMap();
const UNIONS = new Map();
let nextListId = 0;

function listFor(spec, ctx, key) {
  const lists = spec.split('|').map(n => {
    if (!ctx[n]) throw new Error(`names.js: no word list "${n}" in pool ${key}`);
    if (!LIST_ID.has(ctx[n])) LIST_ID.set(ctx[n], nextListId++);
    return ctx[n];
  });
  if (lists.length === 1) return lists[0];
  const id = lists.map(l => LIST_ID.get(l)).join('|');
  if (!UNIONS.has(id)) UNIONS.set(id, [...new Set(lists.flat())]);
  return UNIONS.get(id);
}

function compile(patterns, ctx, key) {
  const out = [];
  let total = 0;
  for (const [w, t] of patterns) {
    if (!(w > 0)) continue;
    const lits = [], lists = [], slots = [];
    let last = 0, size = 1;
    for (const m of t.matchAll(/\{([\w|]+)\}/g)) {
      lits.push(t.slice(last, m.index));
      slots.push(...m[1].split('|'));
      const list = listFor(m[1], ctx, key);
      lists.push(list);
      size *= list.length;
      last = m.index + m[0].length;
    }
    lits.push(t.slice(last));
    total += w;
    const numeral = !slots.some(n => NO_NUMERAL.has(n)) && !NO_NUMERAL_TEXT.test(t);
    out.push({ cum: total, w, lits, lists, size, numeral });
  }
  return { patterns: out, total };
}

/** Two words that repeat each other ("Frost Frost", "Ice Iceberg"). */
function clash(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

/** Draw a name from a pool; `numeral` is the chance of a rare numeral on a short name that can carry one. */
function draw(p, numeral = 0) {
  const r = random() * p.total;
  let pat = p.patterns[p.patterns.length - 1];
  for (const q of p.patterns) if (r < q.cum) { pat = q; break; }
  let s = pat.lits[0];
  const used = [];
  for (let i = 0; i < pat.lists.length; i++) {
    let w = pick(pat.lists[i]);
    for (let k = 0; k < 3 && used.some(u => clash(u, w)); k++) w = pick(pat.lists[i]);
    used.push(w);
    s += w + pat.lits[i + 1];
  }
  if (numeral && pat.numeral && chance(numeral) && s.split(' ').length <= 3) s += ` ${pick(NUMERALS)}`;
  return s;
}

const scale = (pats, f) => pats.map(([w, t]) => [w * f, t]);
const weightOf = (pats) => pats.reduce((a, [w]) => a + w, 0);

function civilPool(culture, key, sub, big) {
  return pool(`civ:${culture}:${key}:${sub || ''}:${big ? 1 : 0}`, () => {
    const liner = key === 'liner';
    let pats = liner ? LINER_PATTERNS : [...CIVIL_PATTERNS, ...(CULTURE_PATTERNS[culture] || []), ...(KIND_PATTERNS[key] || [])];
    if (SUB_PATTERNS[sub]) pats = [...pats, ...SUB_PATTERNS[sub]];
    if (sub === 'ind-water' && (key === 'hauler' || key === 'tanker')) {
      pats = [...pats, ...scale(WATER_PATTERNS, weightOf(pats) * WATER_SHARE / (1 - WATER_SHARE) / weightOf(WATER_PATTERNS))];
    }
    const code = CORP[sub];
    if (code && big) {
      // A company names its hulls itself: no owners' possessives, no jokes, no
      // other house's name. A liner carries the code in place of its line.
      const coded = pats.filter(([, t]) => !CORP_SKIP.test(t)).map(([w, t]) => [w, `${code} ${t.replace('{line} ', '')}`]);
      pats = [...scale(pats, 1 - CORP_SHARE), ...scale(coded, CORP_SHARE)];
    }
    return [pats, { ...SHARED, ...CULT[culture], ...KIND[key] }];
  });
}

function navyPool(faction, kind) {
  const tier = CAPITAL.has(kind) ? 'capital' : 'light';
  return pool(`navy:${faction}:${tier}`, () => {
    const prefix = NAVY_PREFIX[faction];
    const pats = NAVY_PATTERNS[faction][tier].map(([w, t]) => [w, `${prefix} ${t}`]);
    return [pats, {
      ...SHARED, unPerson: UN_PERSON, unPlace: UN_PLACE, unGrand: UN_GRAND, virtue: VIRTUE, rank: NAVY_RANK, navyOf: NAVY_OF,
      // Navies use the one-word Martian names: "MCRN Valles Gauntlet", not "MCRN Holden Crater Arrow".
      marsPlace: MARS_PLACE.filter(p => !p.includes(' ')), founder: MARS_FOUNDER, wind: MARS_WIND, weapon: MARS_WEAPON,
      war: MARS_WAR, lawgiver: MARS_LAWGIVER,
    }];
  });
}

function opaNavyPool(sub) {
  return pool(`opa-navy:${sub || ''}`, () => {
    let pats = OPA_NAVY_PATTERNS;
    if (SUB_PATTERNS[sub]) pats = [...pats, ...scale(SUB_PATTERNS[sub], 1.5)];
    return [pats, { ...SHARED, ...CULT.OPA, opaHero: OPA_HERO, nounK: OPA_MN }];
  });
}

function policePool(faction, sub) {
  const P = POLICE_SUB[sub] || POLICE_PREFIX[faction] || 'Patrol';
  return pool(`police:${P}:${faction}`, () => [
    POLICE_PATTERNS.map(([w, t]) => [w, t.replace('{P}', P)]),
    {
      pvirtue: POLICE_VIRTUE, watchAdj: WATCH_ADJ, watchNoun: WATCH_NOUN, watchPost: WATCH_POST, num: NUMS,
      place: CULT[CULTURE_OF[faction] || 'IND'].place,
    },
  ]);
}

function piratePool(sub) {
  const clan = CLAN[sub] ? sub : '';
  return pool(`pirate:${clan}`, () => {
    // A ship of no known clan draws on every clan's words.
    const lists = clan ? CLAN[clan] : Object.fromEntries(Object.keys(CLAN[CLAN_IDS[0]]).map(k =>
      [k, words(CLAN_IDS.map(c => CLAN[c][k].join(',')).join(','))]));
    return [PIRATE_PATTERNS, { ...SHARED, ...PIRATE, ...lists }];
  });
}

function mercPool(prefix) {
  return pool(`merc:${prefix || ''}`, () => [
    prefix ? [...scale(MERC_PATTERNS, 0.3), ...MERC_PATTERNS.map(([w, t]) => [w * 0.7, `${prefix} ${t}`])] : MERC_PATTERNS,
    { ...SHARED, hardAdj: HARD_ADJ, hardNoun: HARD_NOUN },
  ]);
}

/**
 * Compose a name: { name, style }. The style says how to number it if it
 * clashes: 'navy' (hull number), 'police' (a number) or 'plain' (a numeral).
 */
function compose(o = {}) {
  const faction = o.faction || 'independent';
  const sub = o.sub || null;
  const kind = o.kind || null;
  const key = o.names || NAMES_OF_KIND[kind] || 'freighter';
  const category = o.category || CATEGORY_OF_NAMES[key] || 'civilian';
  const culture = CULTURE_OF[faction] || 'IND';

  if (faction === 'pirate' || key === 'pirate' || category === 'irregular') return { name: draw(piratePool(sub)), style: 'plain' };
  if (INTEL.has(sub)) return { name: civil(culture, KIND[key] ? key : INTEL_KEY[kind] || 'freighter', null, false), style: 'plain' };
  if (category === 'authority' || key === 'police') return { name: draw(policePool(faction, sub)), style: 'police' };
  if (category === 'military' || key === 'navy' || key === 'opa') {
    if (NAVY_PREFIX[faction]) return { name: draw(navyPool(faction, kind)), style: 'navy' };
    if (faction === 'OPA') return { name: draw(opaNavyPool(sub)), style: 'plain' };
    return { name: draw(mercPool(sub === 'ind-merc' ? CORP[sub] : null)), style: 'plain' };
  }
  // A mercenary company's armed light freighters are its warships.
  if (sub === 'ind-merc' && kind === 'light-freighter') return { name: draw(mercPool(CORP[sub])), style: 'plain' };
  return { name: civil(culture, KIND[key] ? key : 'freighter', sub, BIG.has(kind || key)), style: 'plain' };
}

function civil(culture, key, sub, big) {
  return draw(civilPool(culture, key, sub, big), RARE_NUMERAL);
}

/**
 * A fresh name, without the registry: opts { cls, kind, category, names,
 * faction, sub } (a class's kind, category and names pool key, the faction
 * and sub-faction that flies it). May repeat a name already in the game;
 * use shipName for that.
 */
export function rollShipName(opts = {}) {
  return compose(opts).name;
}

// ---- UNIQUENESS ----

const TRIES = 10;
const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];

/** Runtime only: state → Set of taken names (normalized). Never saved. */
const REGISTRY = new WeakMap();

/** Names compare without case, spacing or a wreck's suffix. */
const keyOf = (name) => String(name).replace(/\s*\(wreck\)\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

function registryOf(state) {
  if (!state || typeof state !== 'object') return null;
  let reg = REGISTRY.get(state);
  if (!reg) {
    reg = new Set();
    const list = Array.isArray(state.entities) ? state.entities : Object.values(state.entities || {});
    for (const e of list) if (e?.name) reg.add(keyOf(e.name));
    if (state.ship?.name) reg.add(keyOf(state.ship.name));
    REGISTRY.set(state, reg);
  }
  return reg;
}

/** Number a name that is still taken after TRIES rolls, in its own style (a numbered name gets another number). */
function numbered(name, style, kind, reg) {
  const free = (c) => !reg.has(keyOf(c));
  if (style === 'navy') {
    const code = HULL[kind] || 'X';
    for (let i = 0; ; i++) {
      const c = `${name} (${code}-${i < 20 ? randInt(10, 999) : 1000 + i})`;
      if (free(c)) return c;
    }
  }
  if (style === 'police' || / \d+$/.test(name)) {
    const base = name.replace(/ \d+$/, '');
    for (let i = 0; ; i++) {
      const c = `${base} ${i < 20 ? randInt(2, 999) : 1000 + i}`;
      if (free(c)) return c;
    }
  }
  const base = name.replace(/ (II|III|IV|V|VI|VII)$/, '');
  for (const r of ROMAN) if (free(`${base} ${r}`)) return `${base} ${r}`;
  for (let n = 21; ; n++) if (free(`${base} ${n}`)) return `${base} ${n}`;
}

/**
 * A name nobody else in this game has had: opts as rollShipName. The name
 * is taken for good (a wreck keeps it). Without a state, just a fresh roll.
 */
export function shipName(state, opts = {}) {
  const reg = registryOf(state);
  if (!reg) return rollShipName(opts);
  let c;
  for (let i = 0; i < TRIES; i++) {
    c = compose(opts);
    if (!reg.has(keyOf(c.name))) { reg.add(keyOf(c.name)); return c.name; }
  }
  const name = numbered(c.name, c.style, opts.kind, reg);
  reg.add(keyOf(name));
  return name;
}

/**
 * Mark a name as taken (our own ship, a scripted ship). Returns true if it
 * was free, false if it was already taken (or there is no state).
 */
export function reserveName(state, name) {
  const reg = registryOf(state);
  if (!reg || !name) return false;
  const k = keyOf(name);
  if (reg.has(k)) return false;
  reg.add(k);
  return true;
}

/**
 * Rough size of each name pool: { label: { raw, effective } }. `raw` is the
 * number of names its patterns can spell (overlaps counted twice);
 * `effective` is one over the chance that two draws collide, the size of
 * an evenly drawn pool that would repeat as often.
 */
export function nameEntropy() {
  const out = {};
  const measure = (label, p) => {
    let raw = 0, coll = 0;
    for (const q of p.patterns) {
      const share = q.w / p.total;
      raw += q.size;
      coll += share * share / q.size;
    }
    out[label] = { raw, effective: Math.round(1 / coll) };
  };
  for (const c of Object.keys(CULT)) for (const k of KIND_KEYS) measure(`${c} ${k}`, civilPool(c, k, null, BIG.has(k)));
  for (const f of Object.keys(NAVY_PREFIX)) {
    measure(`${NAVY_PREFIX[f]} light`, navyPool(f, 'frigate'));
    measure(`${NAVY_PREFIX[f]} capital`, navyPool(f, 'battleship'));
  }
  measure('OPA navy', opaNavyPool(null));
  for (const f of Object.keys(POLICE_PREFIX)) measure(`police ${f}`, policePool(f, null));
  for (const c of ['', ...CLAN_IDS]) measure(`pirate ${c || 'any'}`, piratePool(c));
  measure('BSS merc', mercPool('BSS'));
  return out;
}
