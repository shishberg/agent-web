<script setup lang="ts">
import { onBeforeUnmount, shallowRef, type ComponentPublicInstance } from "vue";

type AgentWebExtensionSlotName =
  | "sidebar.top"
  | "sidebar.afterSessions"
  | "sidebar.bottom"
  | "composer.before"
  | "session.details";

type AgentWebExtensionPanel = {
  id: string;
  title?: string;
  slot: string;
  mount(root: HTMLElement): void | (() => void);
};

type AgentWebExtensionsRegistry =
  | {
      panels?: unknown;
    }
  | AgentWebExtensionPanel[];

declare global {
  interface Window {
    __agentWebExtensions__?: AgentWebExtensionsRegistry;
  }
}

const props = defineProps<{
  slotName: AgentWebExtensionSlotName;
}>();

const panels = shallowRef(
  readAgentWebExtensionPanels().filter((panel) => panel.slot === props.slotName),
);
const roots = new Map<string, HTMLElement>();
const unmounts = new Map<string, () => void>();

onBeforeUnmount(() => {
  for (const id of Array.from(roots.keys())) {
    unmountPanel(id);
  }
});

function setPanelRoot(panel: AgentWebExtensionPanel, value: Element | ComponentPublicInstance | null): void {
  const root = value instanceof HTMLElement ? value : null;
  if (!root) {
    unmountPanel(panel.id);
    return;
  }

  if (roots.get(panel.id) === root) return;

  unmountPanel(panel.id);
  roots.set(panel.id, root);
  const unmount = panel.mount(root);
  if (typeof unmount === "function") {
    unmounts.set(panel.id, unmount);
  }
}

function unmountPanel(id: string): void {
  unmounts.get(id)?.();
  unmounts.delete(id);
  roots.delete(id);
}

function readAgentWebExtensionPanels(): AgentWebExtensionPanel[] {
  if (typeof window === "undefined") return [];

  const registry = window.__agentWebExtensions__;
  const panels = Array.isArray(registry) ? registry : registry?.panels;
  return Array.isArray(panels) ? panels.filter(isAgentWebExtensionPanel) : [];
}

function isAgentWebExtensionPanel(value: unknown): value is AgentWebExtensionPanel {
  if (typeof value !== "object" || value === null) return false;

  const panel = value as Partial<AgentWebExtensionPanel>;
  return typeof panel.id === "string" && typeof panel.slot === "string" && typeof panel.mount === "function";
}
</script>

<template>
  <div
    v-if="panels.length"
    class="agent-extension-slot"
    :data-extension-slot="slotName"
  >
    <section
      v-for="panel in panels"
      :key="panel.id"
      class="agent-extension-panel verandah-panel"
      :data-panel="panel.id"
      :aria-label="panel.title"
    >
      <h2 v-if="panel.title" class="agent-extension-title">{{ panel.title }}</h2>
      <div
        class="agent-extension-panel-body verandah-panel-body"
        :ref="(value) => setPanelRoot(panel, value)"
      ></div>
    </section>
  </div>
</template>
