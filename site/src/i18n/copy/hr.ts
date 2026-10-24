// Hrvatski tekst stranice. Pisan izravno, ne prevođen s engleskog; iste tvrdnje, brojke i
// redoslijed odjeljaka. Brojke samo iz facts.json. Izvori tvrdnji: site/CONTENT.md.
// Pojmovi iz API-ja (ledger, intent, claim, bridge, wallet) ostaju kao u kodu.
import type { Copy, LevelKey } from './types';
import { levelKey } from './types';
import { date, num, pl, range } from './format';

const d = (iso: string) => date('hr', iso);
const n = (x: number) => num('hr', x);

const scopes: Record<LevelKey, string> = {
  l0: 'ledger, symbol i wallet kao zapisi; novac se još ne kreće',
  l1: 'intenti issue, transfer i destroy; stanja; asinkrona obrada',
  l3: 'limiti (`minBalance`, `maxBalance`), straničenje, čitanje po luidu',
  records:
    'životni ciklus zapisa: izmjena, dokazi statusa, promjene, brisanje, provjera pristupa; signeri, zapis samog ledgera, sistemske politike',
  access:
    'opseg pravila pristupa, ulaz u ledger, matcheri, circles, politike statusa, impersonacija tokenom, dozvole u claimovima',
  l5: '2PC s jednim bridgeom: pozivi prepare, commit i abort, obavijesti o statusu, ponovni pokušaji, restart',
  l6: 'više bridgeova u jednom intentu: dvofazni prepare, grupiranje, abort samo pripremljenim dijelovima, bridgeovi koji ne odgovaraju',
  routes: 'adrese `schema:handle@parent`, rute walleta: credit, debit, accept, forward',
  events: 'isporuka događaja: outbox, dokazi pokušaja, 501 → cancelled, ponovni pokušaj, nastavak',
  l7: 'niti proslijeđenih intenata; istek intenta (pokriva ga i access4)',
  l9: 'dva ledgera spojena bridgeom: plaćanja između ledgera',
};

export const hr = {
  meta: {
    title: 'open-ledger: ledger kompatibilan s Minkom (MIT)',
    description: (f) =>
      `Server otvorenog koda (MIT) koji na Minka Ledger API odgovara jednako kao Minka: ${f.operations.confirmed} od ${f.operations.total} operacija, svaka potvrđena snimljenom razmjenom s javnim sandboxom.`,
  },

  hero: {
    lead: [
      'open-ledger je server koji na Minka Ledger API odgovara jednako kao Minka. Službeni `@minka/ledger-sdk` i CLI `minka` rade s njim bez ikakvih izmjena. Kod je otvoren, pod licencom MIT.',
      'Uzor je S3. Amazonova implementacija je zatvorena, a ugovor je njezin API, koji MinIO, Ceph i R2 implementiraju na vlastitoj unutrašnjosti. Minka je zatvorena na isti način i javan je samo API kojim joj se obraćaju klijenti. Sve iza tog API-ja u open-ledgeru je vlastiti dizajn.',
    ],
    buttons: {
      github: 'Kod na GitHubu',
      run: 'Pokreni lokalno',
      proof: 'Kako mjerimo kompatibilnost',
    },
  },

  numbers: {
    intro: 'Sve brojke generira `scripts/site-facts.ts` iz samog repozitorija; `npm run check` pada ako su zastarjele.',
    items: [
      {
        value: (f) => `${f.operations.confirmed}/${f.operations.total}`,
        label: (f) =>
          `operacija iz Minkine OpenAPI specifikacije ${f.operations.spec}, sve implementirane i svaka potvrđena snimljenom razmjenom`,
      },
      {
        value: (f) => String(f.exchanges.total),
        label: (f) =>
          `${pl(f.exchanges.total, 'snimljena razmjena', 'snimljene razmjene', 'snimljenih razmjena')} s javnim sandboxom: ${f.exchanges.client} ${pl(f.exchanges.client, 'zahtjev', 'zahtjeva', 'zahtjeva')} klijenta i ${f.exchanges.bridge} ${pl(f.exchanges.bridge, 'poziv', 'poziva', 'poziva')} prema bridgeovima`,
      },
      {
        value: (f) => String(f.tests.postgres),
        label: (f) =>
          `${pl(f.tests.postgres, 'unit test', 'unit testa', 'unit testova')} na Postgresu, u ${f.tests.files} ${pl(f.tests.files, 'datoteci', 'datoteke', 'datoteka')}`,
      },
      {
        value: (f) => f.version.sandbox,
        label: 'verzija sandboxa na kojoj su rađene najnovije snimke; istu verziju javlja i server',
      },
      {
        value: (f) => String(f.divergences.count),
        label: (f) =>
          `${pl(f.divergences.count, 'zapisano, namjerno odstupanje', 'zapisana, namjerna odstupanja', 'zapisanih, namjernih odstupanja')} od reference, u ${f.divergences.fixtures} ${pl(f.divergences.fixtures, 'fixtureu', 'fixturea', 'fixturea')}`,
      },
      {
        value: (f) => String(f.footprint.ledgers),
        label: (f) =>
          `${pl(f.footprint.ledgers, 'ledger koji su snimanja ostavila', 'ledgera koje su snimanja ostavila', 'ledgera koje su snimanja ostavila')} na javnom sandboxu; svaki je zabilježen, a sandbox ih ne može obrisati`,
      },
    ],
  },

  proof: {
    intro:
      'Kompatibilnost se mjeri prema snimkama reference, a ne zaključuje iz dokumentacije. Javni Minkin sandbox snimi se jednom, a open-ledger se zatim pri svakoj provjeri uspoređuje s tom snimkom.',
    steps: [
      'Scenarij iz `conformance/scenarios/` pokreće službeni SDK, pa je svaki zahtjev upravo onakav kakav šalje stvarni klijent.',
      'Proxy za snimanje, `conformance/proxy.ts`, doslovno zapisuje svaku razmjenu sa sandboxom u `conformance/fixtures/*.reference.jsonl`.',
      'Isti scenarij kroz isti proxy prolazi i protiv open-ledgera, a rezultat je `.rec/*.candidate.jsonl`.',
      '`conformance/compare.ts` provjerava status, oblik tijela i svaku vrijednost te javlja koliko se razmjena poklapa od ukupno snimljenih.',
    ],
    placeholders:
      'Vrijednosti koje se mijenjaju pri svakom pokretanju (vremenski trenuci, luidi, ključevi, hashevi, potpisi) zamjenjuju se oznakama numeriranima redom prvog pojavljivanja. Ako se ista vrijednost u referenci pojavi dvaput, mora se dvaput pojaviti i u našem odgovoru, pa se identitet i dalje provjerava. Tekst polja `detail` u greškama uspoređuje se, ali samo se prijavljuje.',
    bridges: (f) =>
      `Za dvofazni commit scenarij pokreće vlastiti bridge, do kojeg sandbox dolazi kroz javni tunel. Tako se snimaju i pozivi koje referenca upućuje tom bridgeu: ${f.fixtures.bridge} ${pl(f.fixtures.bridge, 'fixture', 'fixturea', 'fixturea')} bridgea uz ${f.fixtures.reference} ${pl(f.fixtures.reference, 'fixture', 'fixturea', 'fixturea')} klijenta.`,
    divergences: (f) =>
      `Gdje referenca ima grešku, open-ledger se namjerno ponaša drukčije. Svaki takav slučaj upisan je u \`conformance/divergences.json\`: što se događa, što radi referenca, što radi open-ledger i zašto. Usporedba te razmjene prijavljuje umjesto da padne. Registar trenutačno ima ${f.divergences.count} ${pl(f.divergences.count, 'unos', 'unosa', 'unosa')} u ${f.divergences.fixtures} ${pl(f.divergences.fixtures, 'fixtureu', 'fixturea', 'fixturea')}.`,
    example:
      'Primjer iz L3: issue koji bi wallet podigao iznad njegova `maxBalance` na referenci zauvijek ostaje u statusu `committed`, a open-ledger ga odbija prije pripreme. Zapisani razlog: intent koji nikad ne može doći do konačnog statusa je greška, a ne dio ugovora.',
    precedence:
      'Ondje gdje sandbox ne može pokazati ponašanje, specifikacija je Minkina javna dokumentacija. Kad se dokumentacija i sandbox ne slažu, vrijedi sandbox.',
    diagram: {
      sdk: 'Službeni SDK',
      proxy: 'Proxy za snimanje',
      sandbox: 'Minkin sandbox',
      ours: 'open-ledger',
      reference: 'snimka reference',
      candidate: 'snimka kandidata',
      compare: 'usporedba',
      exceptions: 'divergences.json',
      caption: 'Isti scenarij dvaput prolazi kroz proxy za snimanje: jednom prema Minkinom sandboxu (snimka reference, korak 2), jednom prema open-ledgeru (snimka kandidata, korak 3). Usporedba sparuje dvije snimke razmjenu po razmjenu, a razmjene upisane u divergences.json samo prijavljuje, ne broji ih kao pogreške (korak 4).',
    },
  },

  levels: {
    intro:
      'Svaka razina je skup scenarija snimljenih na sandboxu i ponovljenih protiv open-ledgera na obje pohrane, u memoriji i u Postgresu. Brojevi su razmjene koje se poklapaju od ukupno snimljenih.',
    columns: {
      level: 'Razina',
      scope: 'Opseg',
      client: 'Razmjene klijenta',
      bridge: 'Pozivi bridgea',
      differ: 'Namjerno drukčije',
      fixtures: 'Fixturei',
    },
    scope: (l) => scopes[levelKey(l)] ?? `[[TODO: hrvatski opseg za ${l.id}]]`,
    notes: [
      'L2 (atomičnost više claimova u jednom intentu) nema vlastiti scenarij; pokrivaju je scenariji L1 i L3.',
      'Razmjene koje su namjerno drukčije su unosi iz `divergences.json` za taj fixture. One se prijavljuju, ne ruše provjeru.',
    ],
  },

  interop: {
    paragraphs: [
      '`bridges/ledger-bridge` spaja dva ledgera onako kako plaćanja između ledgera spajaju klirinšku kuću i banku. Klirinški ledger ga vidi kao bridge bankina walleta, a on svaki poziv dvofaznog commita prenosi u bankin ledger kao intente. Nije mu važno čiji je ledger s koje strane.',
      (f) =>
        `\`conformance/scenarios/l9mixed.ts\` pokreće ga u oba smjera protiv javnog Minkina sandboxa: jednom je sandbox klirinška kuća, a open-ledger ledger banke, drugi put obrnuto. U svakom smjeru prolazi nadoplatu, plaćanja prema van i prema unutra, odbijeno terećenje i abort nakon pripremljenog terećenja, a završava tako da je ponuda banke jednaka njezinoj poziciji u klirinškom ledgeru: ${f.interop.supply} = ${f.interop.supply}.`,
      (f) =>
        `Oba smjera su snimljena. \`npm run check\` ih ponavlja samo protiv open-ledgera: poklapa se ${f.interop.mixed.client}/${f.interop.mixed.client} razmjena klijenta i ${f.interop.mixed.bridge}/${f.interop.mixed.bridge} poziva bridgea.`,
      'Službeni CLI `minka` u `scripts/cli-e2e.sh`, koji je dio `npm run check`, prolazi cijeli tok protiv servera: spajanje, signer, ledger, symbol, walleti, issue, transfer, stanja i filtrirani popisi.',
    ],
    docsLink: 'Minkina dokumentacija: plaćanja između ledgera',
  },

  coverage: {
    teaser: (f) => {
      const top = [...f.resources]
        .sort((a, b) => b.total - a.total)
        .slice(0, 4)
        .map((r) => `${r.name} (${r.total})`)
        .join(', ');
      return `Implementirano je svih ${f.operations.total} operacija iz Minkine OpenAPI specifikacije ${f.operations.spec}, raspoređenih u ${f.resources.length} ${pl(f.resources.length, 'resurs', 'resursa', 'resursa')}, a ${f.operations.confirmed} ih je potvrđeno snimljenom razmjenom. Najveći resursi su ${top}.`;
    },
    link: 'Pokrivenost po resursima i operacijama',
    pageIntro: [
      (f) =>
        `Tablicu generira \`conformance/coverage.ts\` iz Minkine objavljene OpenAPI specifikacije ${f.operations.spec}. Kvačica znači da je za tu operaciju u \`conformance/fixtures/\` snimljena razmjena s referencom.`,
      'Server odgovara i na `GET /api/v2`, koji čita `minka server connect`. Taj poziv nije dio specifikacije.',
    ],
  },

  running: {
    requirements: (f) =>
      `Potreban je Node.js ${f.node.engine}. Postgres nije obavezan: bez \`DATABASE_URL\` server koristi pohranu u memoriji, a sve razine prolaze na obje.`,
    commandsIntro: 'U klonu repozitorija:',
    commands: {
      install: 'instalira ovisnosti',
      check: 'sve: provjera tipova, testovi, konformnost, obje pohrane',
      level: 'jedna razina protiv lokalnog servera',
      db: (f) => `Postgres samo za ovaj projekt na :${f.ports.devPostgres}, ispiše DATABASE_URL`,
      cli: (f) => `CLI minka od početka do kraja protiv svježeg servera na :${f.ports.cliE2e}`,
      start: (f) => `server na :${f.ports.server} (bez DATABASE_URL pohrana u memoriji)`,
    },
    envIntro: 'Postavke su varijable okoline:',
    env: {
      DATABASE_URL: 'veza na Postgres; bez nje se koristi pohrana u memoriji',
      PORT: (f) => `port na kojem server sluša (${f.ports.server})`,
      PUBLIC_URL:
        'javna adresa; zajedno sa `SERVER_HANDLE` to javlja `GET /api/v2`. Obavezna iza reverse proxyja (vidi Poznate rupe)',
      OPEN_LEDGER_MASTER_KEY:
        '32 bajta u base64; njime se zatvaraju tajne na koje se pozivaju pravila `secure` u bridgeovima. Bez njega svaki proces stvori vlastiti ključ, tajne se gube pri restartu, a server na to upozorava',
      OPEN_LEDGER_DELIVERY_MAX_RETRIES: 'broj ponovljenih poziva bridgeu prije nego što se poziv otkaže (5, kao na referenci)',
      OPEN_LEDGER_LOG: 'jedan redak po zahtjevu na stderr',
    },
    clients: (f) =>
      `Službenim klijentima treba samo adresa servera, \`http://localhost:${f.ports.server}/api/v2\`. CLI se spaja naredbom \`minka server connect\`, a SDK istu adresu prima kao \`server\`.`,
    record:
      'Ponovno snimanje reference (`npm run conformance:record`) pri svakom pokretanju stvara jedan ledger na javnom sandboxu, a sandbox ledgere ne može brisati. Snima se samo kad se scenarij promijeni; provjera prema postojećim snimkama sandbox ne dira.',
    copy: 'Kopiraj',
    copied: 'Kopirano',
  },

  design: {
    stores: 'Postoje dvije pohrane, Postgres i memorija. Svaka razina testa konformnosti prolazi na obje.',
    serialisation: (f) =>
      `Intenti jednog ledgera obrađuju se jedan po jedan, pod advisory lockom u Postgresu. Izmjereno skriptom \`scripts/bench.ts\` na lokalnom Postgresu ${d(f.bench.measured)} (${f.bench.transfers} transfera između nepovezanih parova walleta): ${range(f.bench.perSecond.oneLedger)} transfera/s na jednom ledgeru, ${range(f.bench.perSecond.fourLedgers)}/s na četiri ledgera i ${range(f.bench.perSecond.sixteenLedgers)}/s na šesnaest. Zaključavanje po walletu izmjereno je i odbačeno: otprilike dvostruko viša gornja granica ne opravdava rizik.`,
    invariantsIntro: 'Unit testovi provjeravaju invarijante koje se na referenci izvana ne mogu vidjeti:',
    invariants: [
      'očuvanje ukupne ponude kroz nasumični niz intenata, uspoređeno s modelom;',
      'nema prekoračenja stanja pod 50 istodobnih transfera;',
      'dva procesa nad istim Postgresom;',
      'oporavak intenata koje je ostavio proces koji se srušio.',
    ],
    lineCoverage: (f) =>
      `Pokrivenost koda u \`server/src\`: ${n(f.lineCoverage.lines)} % redaka, ${n(f.lineCoverage.branches)} % grananja i ${n(f.lineCoverage.functions)} % funkcija, izmjereno ${d(f.lineCoverage.measured)} na commitu \`${f.lineCoverage.commit}\`. Ne mjeri se iznova pri svakom commitu.`,
    gapsTitle: 'Poznate rupe',
    gaps: [
      '`hsh` traži javnu adresu. Claim veže token uz metodu, apsolutni URL i tijelo zahtjeva, onako kako ih je vidio klijent. Iza reverse proxyja postavite `PUBLIC_URL` na adresu `…/api/v2` kojom se služe klijenti; inače se odbija svaki token s `hsh`, jednako kao što referenca odbija token čiji je hash izračunat nad bilo kojom adresom osim njezine.',
      'Serijalizacija je po ledgeru, pa je propusnost unutar jednog ledgera ograničena gornjim brojkama.',
    ],
    backlog:
      'Nije implementirano: politike `schedule` i `layout`, nedovršena izvođenja adaptera `ledger-bridge`, manje povratnih putovanja po intentu i izvršitelj DTC politika, koji čeka da ih sandbox počne izvršavati.',
  },

  nonGoals: {
    paragraphs: [
      'Ledger otvorenog koda ne otvara banku. Licenca, kapital, AML/KYC, provjera sankcija i pristup platnim shemama veći su dio tog posla i ništa od toga nije u ovom repozitoriju. open-ledger je temelj osnovnog bankovnog sustava koji može pokretati institucija s licencom.',
      'Minkin tekst, kod i ime nisu preuzeti. API je implementiran prema promatranom ponašanju i javnoj dokumentaciji. CLI `minka` (UNLICENSED) koristi se kao klijent, a njegov bundle je pročitan da bi se saznalo koje claimove u tokenu šalje; ništa od njegova koda nije ponovno upotrijebljeno. SDK (MIT) je razvojna ovisnost testa konformnosti.',
    ],
  },

  findings: {
    teaser: [
      (f) =>
        `\`FINDINGS.md\` bilježi kako se referentni ledger ponaša na javnom sandboxu i kako je svako ponašanje utvrđeno. Ima ${f.findings.sections} ${pl(f.findings.sections, 'datiran odjeljak', 'datirana odjeljka', 'datiranih odjeljaka')}, od ${d(f.findings.firstDate)} do ${d(f.findings.lastDate)}, najnoviji prvi.`,
      'Među temama su abort prije nego što bridge potvrdi, dva ledgera spojena bridgeom, pristup naslijeđen kroz domene, `hsh` i OAuth te protokol izvještaja.',
    ],
    link: 'Nalazi i registar odstupanja',
    pageIntro: [
      'Svaki nalaz kaže što referenca radi i kako je to utvrđeno. Najnoviji su prvi.',
      (f) =>
        `Drugi dio stranice je \`conformance/divergences.json\`: ${f.divergences.count} ${pl(f.divergences.count, 'mjesto', 'mjesta', 'mjesta')} na kojima se open-ledger namjerno ponaša drukčije od reference, svako s opisom što radi referenca, što radi open-ledger i zašto.`,
    ],
    languageNote: 'Nalazi su napisani na engleskom i ovdje se ne prevode.',
  },
} satisfies Copy;
