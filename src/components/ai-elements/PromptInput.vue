<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { Send } from "@lucide/vue";

const model = defineModel<string>({ required: true });
defineProps<{
  disabled?: boolean;
  sendDisabled?: boolean;
  placeholder?: string;
}>();
const emit = defineEmits<{
  submit: [];
}>();
const textarea = ref<HTMLTextAreaElement | null>(null);
const maxTextareaHeight = 160;

watch(
  model,
  () => {
    void resizeTextarea();
  },
  { flush: "post" }
);

onMounted(() => {
  void resizeTextarea();
});

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    emit("submit");
  }
}

async function resizeTextarea() {
  await nextTick();
  const element = textarea.value;
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, maxTextareaHeight)}px`;
  element.style.overflowY = element.scrollHeight > maxTextareaHeight ? "auto" : "hidden";
}
</script>

<template>
  <form class="prompt-input" @submit.prevent="emit('submit')">
    <textarea ref="textarea" v-model="model" :disabled="disabled" :placeholder="placeholder" rows="1" @keydown="onKeydown" />
    <button type="submit" :disabled="sendDisabled || disabled || !model.trim()" aria-label="Send" title="Send">
      <Send :size="18" aria-hidden="true" />
    </button>
  </form>
</template>
