import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import AdminDashboardClient from "@/app/admin/AdminDashboardClient";

export default async function AdminPage() {
  const currentUser = await getCurrentUser();

  if (!currentUser) {
    redirect("/auth");
  }

  if (currentUser.role !== "admin") {
    redirect("/");
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <AdminDashboardClient />
    </div>
  );
}
