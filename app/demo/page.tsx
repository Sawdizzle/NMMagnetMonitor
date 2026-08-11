import Dashboard from "@/components/Dashboard";

// Same dashboard component as the live app; demo mode (from the layout's
// DemoProvider) routes it to fixtures instead of Supabase.
export default function DemoHome() {
  return <Dashboard />;
}
