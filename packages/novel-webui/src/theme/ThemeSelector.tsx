import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme, type ThemeMode } from "./ThemeProvider";

const options: { icon: typeof Sun; labelKey: string; mode: ThemeMode }[] = [
  { icon: Sun, labelKey: "profile.preferences.theme.light", mode: "light" },
  { icon: Moon, labelKey: "profile.preferences.theme.dark", mode: "dark" },
  { icon: Monitor, labelKey: "profile.preferences.theme.system", mode: "system" },
];

export function ThemeSelector() {
  const { t } = useTranslation();
  const { mode, setMode } = useTheme();
  const CurrentIcon = options.find((option) => option.mode === mode)?.icon ?? Monitor;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={t("profile.preferences.theme.aria")} className="icon-button theme-selector-trigger">
        <CurrentIcon size={16} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className="dropdown-content theme-selector-menu" sideOffset={6}>
          {options.map(({ icon: Icon, labelKey, mode: optionMode }) => (
            <DropdownMenu.Item className="dropdown-item theme-selector-option" key={optionMode} onSelect={() => setMode(optionMode)}>
              <Icon size={14} />
              <span>{t(labelKey)}</span>
              {mode === optionMode ? <Check size={14} /> : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
