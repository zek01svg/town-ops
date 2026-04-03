import { createContext, useEffect, useState, useContext } from "react";

type Theme = "dark" | "light" | "system";
type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};
type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};
const ThemeProviderContext = createContext<ThemeProviderState | undefined>(
  undefined
);

/**
 * A provider that manages the theme of the application.
 * @param children The children of the provider.
 * @param defaultTheme The default theme of the application.
 * @param storageKey The key used to store the theme in local storage.
 * @returns A provider that manages the theme of the application.
 */
export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vibecards-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window !== "undefined"
      ? (localStorage.getItem(storageKey) as Theme | null) || defaultTheme
      : defaultTheme
  );
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      root.classList.add(systemTheme);
      return;
    }
    root.classList.add(theme);
  }, [theme]);
  const value = {
    theme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme);
      setTheme(theme);
    },
  };
  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}
export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider");
  return context;
};
