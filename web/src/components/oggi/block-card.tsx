import { type ReactNode, useId } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Il contenitore di un blocco di Oggi: una regione col suo titolo e il conteggio
// ("Fatture da emettere (2)"). Un blocco che non si è caricato non ha un conteggio: `count` è null.
export function BlockCard({ title, count, children }: { title: string; count: number | null; children: ReactNode }) {
  const headingId = useId();
  // Testo intero in una stringa: in JSX `a ({n})` diventa più nodi di testo.
  const heading = count === null ? title : `${title} (${count})`;

  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id={headingId}>{heading}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  );
}
