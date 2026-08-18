import Debrief from "@/components/Debrief";

// Same component as the live app; demo mode (from the layout's DemoProvider)
// points it at /api/demo/debrief, which always resolves the is_demo org.
export default function DemoDebriefPage() {
  return <Debrief />;
}
