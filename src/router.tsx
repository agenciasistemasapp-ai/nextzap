import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RoutePendingComponent, RouteErrorComponent } from "./components/route-fallbacks";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false, retry: 1 },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: RoutePendingComponent,
    defaultPendingMs: 300,
    defaultPendingMinMs: 200,
    defaultErrorComponent: RouteErrorComponent,
  });

  return router;
};
