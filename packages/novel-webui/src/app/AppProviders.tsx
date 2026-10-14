import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { PropsWithChildren, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { DisplayScaleProvider } from "../display/DisplayScaleProvider";
import { LocaleProvider } from "../i18n/LocaleProvider";
import { ThemeProvider } from "../theme/ThemeProvider";

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 30_000,
      },
      mutations: { retry: 0 },
    },
  }));

  return (
    <LocaleProvider>
      <ThemeProvider>
        <DisplayScaleProvider>
          <QueryClientProvider client={queryClient}>
            <Tooltip.Provider delayDuration={350}>
              <BrowserRouter>{children}</BrowserRouter>
            </Tooltip.Provider>
          </QueryClientProvider>
        </DisplayScaleProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}
