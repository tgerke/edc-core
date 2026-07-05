import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { useLogout, useMe } from "./api/hooks.js";
import { Button, Spinner } from "./components/ui.js";
import { BuilderPage } from "./pages/BuilderPage.js";
import { FormEntryPage } from "./pages/FormEntryPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { MatrixPage } from "./pages/MatrixPage.js";
import { QueriesPage } from "./pages/QueriesPage.js";
import { StudiesPage } from "./pages/StudiesPage.js";
import { StudyPage } from "./pages/StudyPage.js";

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

function AppShell() {
  const { data: me, isPending } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  if (isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50">
        <Spinner />
      </main>
    );
  }
  if (!me) return <Navigate to="/login" />;

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
            <span className="text-sm text-zinc-500">{me.fullName}</span>
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

const formEntryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/forms/$formInstanceId",
  component: FormEntryPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    studiesRoute,
    studyRoute,
    builderRoute,
    matrixRoute,
    queriesRoute,
    formEntryRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
