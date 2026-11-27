// Le nove sezioni di Impostazioni. Sicuro per il client: nessun import dal server.

export const SECTION_SLUGS = [
  "studio",
  "orari",
  "fisco",
  "iscrizione-e-polizza",
  "cartella",
  "messaggi",
  "consensi",
  "aspetto",
  "dati-di-prova",
] as const;

export type SectionSlug = (typeof SECTION_SLUGS)[number];

/** Le sezioni costruite, nell'ordine del sottomenu. `demoOnly`: esiste solo in uno studio demo. */
export const BUILT_SECTIONS: readonly { slug: SectionSlug; label: string; demoOnly?: true }[] = [
  { slug: "studio", label: "Studio" },
  { slug: "orari", label: "Orari" },
  { slug: "fisco", label: "Fisco" },
  { slug: "iscrizione-e-polizza", label: "Iscrizione e polizza" },
  { slug: "cartella", label: "Cartella" },
  { slug: "messaggi", label: "Messaggi" },
  { slug: "consensi", label: "Consensi" },
  { slug: "aspetto", label: "Aspetto" },
  { slug: "dati-di-prova", label: "Dati di prova", demoOnly: true },
];

/** Lo slug è una sezione costruita e, se è solo demo, lo studio lo è. Ogni altro slug dà `notFound()`. */
export function isBuiltSection(slug: string, isDemo: boolean): boolean {
  const section = BUILT_SECTIONS.find((s) => s.slug === slug);
  return section !== undefined && (section.demoOnly !== true || isDemo);
}
