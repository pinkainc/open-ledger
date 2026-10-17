# Što radi `npm run check`

`npm run check` (`scripts/check.sh`) je sve što mora biti zeleno prije commita.
Radi **potpuno lokalno**:

- **ne zove Minka staging** (`ldg-stg.one`). Staging se zove samo u `run.sh record`,
  a check ga nikad ne pokreće.
- **ne zove nijedan LLM**.
- **ne koristi Docker**. Postgres je projektni, iz Homebrewa (`scripts/dev-db.sh`,
  podaci u `.rec/pgdata`, port 5439).

Traje dulje od 10 minuta jer se 57 conformance razina vrti dvaput (memorija i Postgres),
a neke čekaju stvarno vrijeme: `daywindow` 40 s, `cli` oko 50 s.

## Tok

```mermaid
flowchart TD
    start([npm run check]) --> db["dev-db.sh fresh open_ledger_test<br/>prazna Postgres baza"]
    db --> tsc["tsc -p .<br/>typecheck"]
    tsc --> unit["npm test<br/>node --test, 28 datoteka<br/>memorija + Postgres"]
    unit -->|pad| fail([exit 1, ispis ✖])
    unit --> loop{"za svaku razinu u<br/>conformance/fixtures/*.reference.jsonl<br/>(57)"}
    loop --> pend{"u pending.json?"}
    pend -->|da| skip1["ispiše razlog, preskače"] --> loop
    pend -->|ne| cliq{"razina cli, a<br/>minka CLI nije instaliran?"}
    cliq -->|da| skip2["preskače"] --> loop
    cliq -->|ne| stores["memorija, pa Postgres<br/>(svaki put prazna baza open_ledger_conf)"]
    stores --> runsh["conformance/run.sh check &lt;razina&gt;"]
    runsh -->|razmjene se ne podudaraju| fail
    runsh --> loop
    loop -->|gotovo| e2e["scripts/cli-e2e.sh<br/>službeni minka CLI kroz cijeli tok<br/>Postgres, port 4640"]
    e2e -->|pad| fail
    e2e --> cov["conformance/coverage.ts<br/>piše COVERAGE.md"]
    cov --> fp["conformance/footprint.ts verify<br/>svaka snimka je u footprint.jsonl"]
    fp --> ok([zeleno])
```

## Jedna razina: `run.sh check <razina>`

Scenarij (`conformance/scenarios/<razina>.ts`) je obični TypeScript klijent koji preko
`@minka/ledger-sdk` ili HTTP-a izvodi tok, npr. ledger → walleti → intent → saldo.
Isti scenarij se izvodi i kod snimanja i kod provjere. Razlika je samo u tome kamo
proxy prosljeđuje.

```mermaid
sequenceDiagram
    autonumber
    participant R as run.sh check
    participant S as naš server<br/>server/src/main.ts :4620
    participant P as proxy.ts :4610
    participant Sc as scenarij<br/>scenarios/razina.ts
    participant B as bridge.ts :4630<br/>(samo needs-bridge)
    participant C as compare.ts

    R->>S: pokreni (PUBLIC_URL = adresa stagea,<br/>OPEN_LEDGER_MINUTE_MS = 1000)
    R->>P: pokreni, TARGET = naš server,<br/>OUT = .rec/razina.candidate.jsonl
    opt scenarij traži bridge
        R->>B: pokreni, OUT = .rec/razina.bridge.candidate.jsonl
    end
    R->>Sc: pokreni, BASE = proxy
    loop svaki zahtjev scenarija
        Sc->>P: HTTP zahtjev
        P->>S: proslijedi nepromijenjen
        S-->>B: poziv bridgea (ako ga ima)
        B-->>S: 202, pa asinkroni proof
        S-->>P: odgovor
        P->>P: zapiši razmjenu u candidate.jsonl
        P-->>Sc: odgovor
    end
    R->>C: usporedi fixtures/razina.reference.jsonl<br/>s .rec/razina.candidate.jsonl
    opt postoji fixtures/razina.bridge.jsonl
        R->>C: usporedi i pozive bridgea
    end
    C-->>R: "N/N exchanges match" ili FAIL
    R->>R: cleanup: ugasi procese, čekaj da se portovi oslobode
```

### Što `compare.ts` provjerava

| Kako | Što |
|---|---|
| Strogo | HTTP status, oblik tijela, svaka normalizirana vrijednost |
| Normalizirano | trenuci, luidovi, ključevi, hashevi, potpisi, handle ledgera iz runa: zamijenjeni oznakama po redu prvog pojavljivanja, pa se identitet i dalje provjerava (isti luid mora se vratiti tamo gdje se vratio i u snimci) |
| Blago (ispis, ne pad) | tekst `detail` u greškama |
| Ignorirano | `custom.trace`, jer referentni ledger vraća stack trace koji ne kopiramo |

## Snimanje i provjera

Fixture u `conformance/fixtures/` nastaje jednom, snimanjem na sandboxu (`run.sh record`).
Check tu snimku samo čita.

```mermaid
flowchart LR
    subgraph record["run.sh record (ručno, rijetko)"]
        direction LR
        sc1[scenarij] --> px1[proxy :4610] --> stg[("Minka sandbox<br/>ldg-stg.one")]
        px1 --> fx[("fixtures/razina.reference.jsonl")]
        stg -. preko cloudflared tunela .-> br1[bridge.ts :4630]
        br1 --> fxb[("fixtures/razina.bridge.jsonl")]
        px1 -. start i end .-> fpl[("footprint.jsonl")]
    end
    subgraph check["run.sh check (svaki npm run check)"]
        direction LR
        sc2[isti scenarij] --> px2[proxy :4610] --> ol[open-ledger :4620<br/>memorija ili Postgres]
        ol --> br2[bridge.ts :4630]
        px2 --> cand[(".rec/razina.candidate.jsonl")]
    end
    fx --> cmp{compare.ts}
    cand --> cmp
```

Snimanje stvara ledger na sandboxu koji se ne može obrisati, pa se svaki run zapisuje
u `conformance/footprint.jsonl` prije prvog zahtjeva. `footprint.ts verify` na kraju
checka provjerava da za svaku fixture postoji zapis i da je `docs/sandbox-footprint.md`
ažuran. Ta provjera samo čita lokalne datoteke.

## Praktično

- **Portovi 4610, 4620, 4630 i 4640** su zauzeti dok check radi. Drugi conformance run
  u isto vrijeme odbija start (`port … is in use`). Prije je dijeljenje proxyja pomiješalo
  dva scenarija u jednu fixture (`access4`).
- **Logovi:** `.rec/test.log` (unit), `.rec/conf.log` (zadnja razina), `.rec/server.log`,
  `.rec/proxy.log`, `.rec/cli.log`.
- **Posebne oznake u scenariju:** `// day-boundary` (daywindow: server dobiva granicu dana
  40 s unaprijed), `// minute-ms: <n>` (vlastita duljina minute za istek intenta),
  `needs-bridge`, `needs-local-server`.
- **Pending:** razina u `conformance/pending.json` se preskače s razlogom. Danas je
  datoteka prazna.
