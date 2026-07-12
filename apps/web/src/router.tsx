import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useLogout, useMe } from "./api/hooks.js";
import { NotificationsBell } from "./components/NotificationsBell.js";
import { Button, Spinner } from "./components/ui.js";
import { AdminAccessLogPage } from "./pages/AdminAccessLogPage.js";
import { AdminAnomaliesPage } from "./pages/AdminAnomaliesPage.js";
import { AdminDictionariesPage } from "./pages/AdminDictionariesPage.js";
import { AdminUsersPage } from "./pages/AdminUsersPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import { BuilderPage } from "./pages/BuilderPage.js";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.js";
import { CodingPage } from "./pages/CodingPage.js";
import { FormEntryPage } from "./pages/FormEntryPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { MatrixPage } from "./pages/MatrixPage.js";
import { QueriesPage } from "./pages/QueriesPage.js";
import { ReauthCompletePage } from "./pages/ReauthCompletePage.js";
import { StudiesPage } from "./pages/StudiesPage.js";
import { StudyPage } from "./pages/StudyPage.js";
import { TeamPage } from "./pages/TeamPage.js";
import { WorkbenchPage } from "./pages/WorkbenchPage.js";

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const reauthCompleteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reauth-complete",
  component: ReauthCompletePage,
});

function AppShell() {
  const { data: me, isPending } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();

  if (isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50">
        <Spinner />
      </main>
    );
  }
  if (!me) return <Navigate to="/login" />;
  // A temporary admin-issued password unlocks nothing but this form; the
  // server enforces the same gate (403 password_change_required).
  if (me.mustChangePassword && location.pathname !== "/account/password") {
    return <Navigate to="/account/password" />;
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <Link to="/studies" className="font-semibold tracking-tight text-zinc-900">
            edc-core
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              to="/studies"
              className="rounded-lg px-3 py-1.5 text-zinc-600 hover:bg-zinc-100 [&.active]:bg-zinc-100 [&.active]:font-medium [&.active]:text-zinc-900"
            >
              Studies
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <NotificationsBell />
            {me.hasPassword ? (
              <Link to="/account/password" className="text-sm text-zinc-500 hover:text-zinc-900">
                {me.fullName}
              </Link>
            ) : (
              <span className="text-sm text-zinc-500">{me.fullName}</span>
            )}
            <Button
              variant="ghost"
              onClick={async () => {
                await logout.mutateAsync();
                await navigate({ to: "/login" });
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: () => <Navigate to="/studies" />,
});

const studiesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/studies",
  component: StudiesPage,
});

const studyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/studies/$studyId",
  component: StudyPage,
});

const builderRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/studies/$studyId/builds/$version",
  component: BuilderPage,
});

const matrixRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/studies/$studyId/subjects",
  component: MatrixPage,
});

const queriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/studies/$studyId/queries",
  component: QueriesPage,
});

const codingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/studies/$studyId/coding",
  component: CodingPage,
});

const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/studies/$studyId/audit",
  component: AuditPage,
});

const adminDictionariesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/dictionaries",
  component: AdminDictionariesPage,
});

const adminUsersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/users",
  component: AdminUsersPage,
});

const adminAccessLogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/access-log",
  component: AdminAccessLogPage,
});

const adminAnomaliesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/anomalies",
  component: AdminAnomaliesPage,
});

const changePasswordRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/account/password",
  component: ChangePasswordPage,
});

const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/studies/$studyId/team",
  component: TeamPage,
});

const workbenchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/studies/$studyId/workbench",
  component: WorkbenchPage,
});

const formEntryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/forms/$formInstanceId",
  component: FormEntryPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  reauthCompleteRoute,
  appRoute.addChildren([
    indexRoute,
    studiesRoute,
    studyRoute,
    builderRoute,
    matrixRoute,
    queriesRoute,
    codingRoute,
    auditRoute,
    adminDictionariesRoute,
    adminUsersRoute,
    adminAccessLogRoute,
    adminAnomaliesRoute,
    changePasswordRoute,
    teamRoute,
    workbenchRoute,
    formEntryRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
