import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { loadHandbookData } from "@/lib/handbook";
import HandbookContent from "@/components/HandbookContent";

/**
 * The operations handbook. A SERVER component, for the same reason /docs is:
 * who may read it is decided here, and an unauthorised caller's response
 * carries nothing to find.
 *
 * The fleet numbers are read on every load rather than baked in. A handbook
 * whose "right now" section is a snapshot of the day it was written gets
 * believed once and distrusted afterwards, and this page exists to be believed.
 */
export default async function HandbookPage() {
  const session = await getSession();
  if (!session || session.role !== "admin" || !session.activeOrgId) redirect("/");

  return <HandbookContent data={await loadHandbookData(session.activeOrgId)} />;
}
