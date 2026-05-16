<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

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

watch(
  model,
  () => {
    void resizeTextarea();
  },
  { flush: "post" }
);

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
  element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
}
</script>

<template>
  <form class="prompt-input" @submit.prevent="emit('submit')">
    <textarea ref="textarea" v-model="model" :disabled="disabled" :placeholder="placeholder" rows="1" @keydown="onKeydown" />
    <button type="submit" :disabled="sendDisabled || disabled || !model.trim()" title="Send">↑</button>
  </form>
</template>
