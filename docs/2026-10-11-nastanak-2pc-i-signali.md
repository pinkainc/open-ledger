# Nastanak: 2PC rubovi, signali i čekanje potpisa — 2026-10-11, sesija S7

Nastavak [`2026-10-10-nastanak-cross-ledger.md`](2026-10-10-nastanak-cross-ledger.md).
Ponašanje reference je u [`FINDINGS.md`](../FINDINGS.md) (unos 2026-10-11), plan u
[`2026-10-10-plan-do-paritete.md`](2026-10-10-plan-do-paritete.md).

## Tri scenarija, tri snimke

Sva otvorena pitanja `(?)` iz L4, L6 i L8 skupljena su u tri scenarija, svaki snimljen
jednom na 2.47.4:

| Scenarij | Pitanja | Rezultat |
| --- | --- | --- |
| `waits` | što pokreće intent koji čeka potpis; drop financiranog walleta | 28/28 nakon ispravke teksta greške |
| `edges2pc` | debit koji padne dok drugi čeka; kasni `prepared`; nepotvrđeni commit; bulk retry i `cancelled` | 27/27 + 28/28 odmah, server bez promjena |
| `signals2` | `*-proofs-added`, `bridge-entry-*`, `wallet-limited`, `intent-updated` bridgeanog i odbijenog, više kredita istom walletu, nedostupan webhook | 37/37 + 46/46 nakon četiri ispravke |

Svi su ograničeni: nijedan effect ne stvara intent, svaki neuspjeli poziv ili dobiva 501
ili se javlja jednom, a nedostupni webhook okida jednom i odustaje nakon limita.

## Što se promijenilo u serveru

- **`*-proofs-added`** se diže po spremanju, a ne samo na POST proofa: pri kreiranju
  svakog recorda (zadnji proof, onaj ledgerov), po svakoj spremljenoj verziji intenta
  iza `pending` (njezin zadnji proof) i po svakom poslanom proofu. Payload nosi record po
  handleu, ne cijeli record.
- **POST proofa na intent je i `intent-updated`**: verzija nakon i verzija prije, obje
  onakve kakve su spremljene, s `domains: []`. Jezgra svoje verzije šalje bez `domains`,
  ali verzija od koje prolaz kreće (spremljena) ih ima.
- **`wallet-limited`** po limit claimu, s verzijom intenta u kojoj je commitan.
- **Nedostupna mreža** (`delivery.target-unreachable`) dobiva deset ponovnih pokušaja,
  HTTP greška i dalje pet.
- Drop financiranog walleta: tekst reference i `custom.symbols`.

## Alat

- `conformance/bridge.ts`: odluka `{hold: …}` drži izvještaj o prepareu do `release()`,
  za kasni `prepared`.
- `run.sh`: scenarij može imati svoju minutu (`// minute-ms: <n>`). `waits` gleda intent
  koji čeka 10 s, a s minutom od 1 s isteknuo bi prije nego što ga pročita.
- `compare.ts`: događaji i liste isporuka efekta poredaju se i po jednostavnim
  vrijednostima (iznos, handle intenta) i po sažetku proofova. Referenca ih stvara
  asinkrono, pa im je redoslijed slučajan.

## Odluke

- **Domain-specific access policies** (`handle@domain`, `filter`, `invoke`) su bile
  `(?)` u L4, ali pripadaju domenama. Premještene su na popis domena koji snima S8.
- `bridge-entry-*` se na referenci ne dižu; ni kod nas. Ako se pojave u novijoj verziji,
  snimka će ih pokazati.
