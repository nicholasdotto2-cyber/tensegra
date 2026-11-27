import { DEFAULT_TEMPLATES, type TemplateKey, type Variant } from "@/lib/messages/templates";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { restoreMessageTemplate } from "@/server/domain/messages/commands";

// I modelli dei messaggi della demo: i cinque modelli nei due toni, scritti da «Ripristina il
// testo originale» delle Impostazioni, quindi uguali ai testi di default e non personalizzati. Nessun
// messaggio nel registro: i promemoria di domani restano «Da inviare».

export async function seedMessageTemplates(tx: Tx, practiceId: string, clock: Clock): Promise<void> {
  for (const key of Object.keys(DEFAULT_TEMPLATES) as TemplateKey[]) {
    for (const variant of Object.keys(DEFAULT_TEMPLATES[key]) as Variant[]) {
      await restoreMessageTemplate(tx, practiceId, clock, { key, variant });
    }
  }
}
