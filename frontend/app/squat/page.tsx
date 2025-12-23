import { Suspense } from "react";

import SquatPageClient from "./SquatPageClient";

export default function SquatPage() {
  return (
    <Suspense fallback={null}>
      <SquatPageClient />
    </Suspense>
  );
}
