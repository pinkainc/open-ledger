// UI strings and section headings. Body copy for the sections comes in W4.
export const languages = { en: 'English', hr: 'Hrvatski' } as const;
export type Lang = keyof typeof languages;
export const langs = Object.keys(languages) as Lang[];

// Section ids follow site/CONTENT.md, sections 1-10. Section 11 is the footer,
// section 12 (technical requirements) is head metadata, not a visible section.
export const sectionIds = [
  'hero',
  'numbers',
  'proof',
  'levels',
  'interop',
  'coverage',
  'running',
  'design',
  'non-goals',
  'findings',
] as const;
export type SectionId = (typeof sectionIds)[number];

type Dict = {
  title: string;
  description: string;
  skip: string;
  navLabel: string;
  nav: Partial<Record<SectionId, string>>;
  sections: Record<SectionId, string>;
  themeToggle: string;
  themeLight: string;
  themeDark: string;
  langSwitch: string;
  heroBadge: (confirmed: number, total: number) => string;
  footer: { license: string; disclaimer: string; source: string; contact: string };
};

export const ui: Record<Lang, Dict> = {
  en: {
    title: 'open-ledger: a Minka-compatible ledger',
    description:
      'An open-source (MIT) server that answers the Minka Ledger API the way Minka does.',
    skip: 'Skip to content',
    navLabel: 'Sections',
    nav: {
      proof: 'Proof',
      levels: 'Levels',
      coverage: 'Coverage',
      running: 'Run it',
      findings: 'Findings',
    },
    sections: {
      hero: 'A Minka-compatible ledger',
      numbers: 'Numbers',
      proof: 'How compatibility is proven',
      levels: 'Levels L0-L9',
      interop: 'Interoperability with Minka',
      coverage: 'API coverage',
      running: 'Running it',
      design: 'Design and limits',
      'non-goals': 'What this is not',
      findings: 'Findings about the reference',
    },
    themeToggle: 'Toggle colour theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    langSwitch: 'Hrvatski',
    heroBadge: (c, t) => `${c}/${t} operations confirmed against the sandbox`,
    footer: {
      license: 'MIT licence',
      disclaimer:
        'open-ledger is an independent project and is not affiliated with or endorsed by Minka Inc.; "Minka" refers to their product only to name the API this server is compatible with.',
      source: 'Source on GitHub',
      contact: 'Contact',
    },
  },
  hr: {
    title: 'open-ledger: ledger kompatibilan s Minkom',
    description:
      'Server otvorenog koda (MIT) koji odgovara na Minka Ledger API onako kako odgovara Minka.',
    skip: 'Preskoči na sadržaj',
    navLabel: 'Odjeljci',
    nav: {
      proof: 'Dokaz',
      levels: 'Razine',
      coverage: 'Pokrivenost',
      running: 'Pokretanje',
      findings: 'Nalazi',
    },
    sections: {
      hero: 'Ledger kompatibilan s Minkom',
      numbers: 'Brojke',
      proof: 'Kako se kompatibilnost dokazuje',
      levels: 'Razine L0-L9',
      interop: 'Interoperabilnost s Minkom',
      coverage: 'Pokrivenost API-ja',
      running: 'Pokretanje',
      design: 'Dizajn i ograničenja',
      'non-goals': 'Što ovo nije',
      findings: 'Nalazi o referenci',
    },
    themeToggle: 'Promijeni temu',
    themeLight: 'Svijetla',
    themeDark: 'Tamna',
    langSwitch: 'English',
    heroBadge: (c, t) => `${c}/${t} operacija potvrđeno protiv sandboxa`,
    footer: {
      license: 'Licenca MIT',
      disclaimer:
        'open-ledger je nezavisan projekt, nije povezan s tvrtkom Minka Inc. niti ga ona podržava; „Minka” ovdje označava njihov proizvod samo da bi se imenovao API s kojim je ovaj server kompatibilan.',
      source: 'Izvorni kod na GitHubu',
      contact: 'Kontakt',
    },
  },
};

export const otherLang = (lang: Lang): Lang => (lang === 'en' ? 'hr' : 'en');
