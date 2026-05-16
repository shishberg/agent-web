<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { Check, Copy } from "@lucide/vue";
import { copyTextToClipboard } from "../../lib/clipboard";

const props = defineProps<{
  role: "user" | "assistant" | "system";
  streaming?: boolean;
  copyText?: string;
}>();

type CopyStatus = "idle" | "copied" | "failed";

const copyStatus = ref<CopyStatus>("idle");
const canCopy = computed(() => props.copyText !== undefined);
const copyLabel = computed(() => {
  if (copyStatus.value === "copied") return "Message copied";
  if (copyStatus.value === "failed") return "Copy failed";
  return "Copy message";
});
const copyTitle = computed(() => {
  if (copyStatus.value === "copied") return "Copied";
  if (copyStatus.value === "failed") return "Copy failed";
  return "Copy message";
});
let copyResetTimer: number | undefined;

onBeforeUnmount(() => {
  if (copyResetTimer !== undefined) {
    window.clearTimeout(copyResetTimer);
  }
});

async function copyMessage() {
  if (props.copyText === undefined) {
    return;
  }

  try {
    await copyTextToClipboard(props.copyText);
    copyStatus.value = "copied";
  } catch {
    copyStatus.value = "failed";
  }

  if (copyResetTimer !== undefined) {
    window.clearTimeout(copyResetTimer);
  }
  copyResetTimer = window.setTimeout(() => {
    copyStatus.value = "idle";
  }, 1200);
}
</script>

<template>
  <article class="message" :class="[`message-${role}`, { streaming }]">
    <div class="message-role">{{ role }}</div>
    <div class="message-body">
      <button
        v-if="canCopy"
        class="message-copy-button"
        :class="{ copied: copyStatus === 'copied', failed: copyStatus === 'failed' }"
        type="button"
        :aria-label="copyLabel"
        :title="copyTitle"
        @click="copyMessage"
      >
        <component :is="copyStatus === 'copied' ? Check : Copy" :size="15" aria-hidden="true" />
      </button>
      <slot />
    </div>
  </article>
</template>
