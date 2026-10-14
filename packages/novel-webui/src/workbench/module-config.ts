export type WorkbenchModuleId = "overview" | "world" | "characters" | "outline" | "scripts" | "chapters" | "continuity" | "lingqi";

export interface WorkbenchModule {
  id: WorkbenchModuleId;
  labelKey: `workbench.modules.${WorkbenchModuleId}.label`;
  descriptionKey: `workbench.modules.${WorkbenchModuleId}.description`;
  documentTypes: string[];
}

export const WORKBENCH_MODULES: WorkbenchModule[] = [
  { id: "overview", labelKey: "workbench.modules.overview.label", descriptionKey: "workbench.modules.overview.description", documentTypes: [] },
  { id: "world", labelKey: "workbench.modules.world.label", descriptionKey: "workbench.modules.world.description", documentTypes: ["worldview"] },
  { id: "characters", labelKey: "workbench.modules.characters.label", descriptionKey: "workbench.modules.characters.description", documentTypes: ["character", "relationships"] },
  { id: "outline", labelKey: "workbench.modules.outline.label", descriptionKey: "workbench.modules.outline.description", documentTypes: ["volume", "chapter-card", "foreshadow"] },
  { id: "scripts", labelKey: "workbench.modules.scripts.label", descriptionKey: "workbench.modules.scripts.description", documentTypes: ["director-script"] },
  { id: "chapters", labelKey: "workbench.modules.chapters.label", descriptionKey: "workbench.modules.chapters.description", documentTypes: ["chapter-text"] },
  { id: "continuity", labelKey: "workbench.modules.continuity.label", descriptionKey: "workbench.modules.continuity.description", documentTypes: ["story-summary", "character-state", "foreshadow"] },
  { id: "lingqi", labelKey: "workbench.modules.lingqi.label", descriptionKey: "workbench.modules.lingqi.description", documentTypes: ["lingqi"] },
];

export function getWorkbenchModule(value?: string): WorkbenchModule {
  return WORKBENCH_MODULES.find((item) => item.id === value) ?? WORKBENCH_MODULES[0];
}

export function isWorkbenchModuleId(value?: string): value is WorkbenchModuleId {
  return WORKBENCH_MODULES.some((item) => item.id === value);
}
