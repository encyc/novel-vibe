import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Type } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDisplayScale, type DisplayScale } from "./DisplayScaleProvider";

const options: { key: string; scale: DisplayScale }[] = [
  { key: "extraCompact", scale: "extra-compact" },
  { key: "compact", scale: "compact" },
  { key: "default", scale: "default" },
  { key: "comfortable", scale: "comfortable" },
  { key: "large", scale: "large" },
];

export function DisplayScaleSelector() {
  const { t } = useTranslation();
  const { scale, setScale } = useDisplayScale();
  const current = options.find((option) => option.scale === scale) ?? options[1];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={t("profile.preferences.display.aria", { label: t(`profile.preferences.display.${current.key}.label`) })} className="icon-button display-scale-trigger">
        <Type size={16} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className="dropdown-content display-scale-menu" sideOffset={6}>
          {options.map((option) => (
            <DropdownMenu.Item
              className="dropdown-item display-scale-option"
              key={option.scale}
              onSelect={() => setScale(option.scale)}
            >
              <span>
                <strong>{t(`profile.preferences.display.${option.key}.label`)}</strong>
                <small>{t(`profile.preferences.display.${option.key}.detail`)}</small>
              </span>
              {scale === option.scale ? <Check size={14} /> : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
