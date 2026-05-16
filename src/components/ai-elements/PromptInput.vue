<script setup lang="ts">
const model = defineModel<string>({ required: true });
defineProps<{
  disabled?: boolean;
  placeholder?: string;
}>();
const emit = defineEmits<{
  submit: [];
}>();

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    emit("submit");
  }
}
</script>

<template>
  <form class="prompt-input" @submit.prevent="emit('submit')">
    <textarea v-model="model" :disabled="disabled" :placeholder="placeholder" rows="5" @keydown="onKeydown" />
    <button type="submit" :disabled="disabled || !model.trim()">Send</button>
  </form>
</template>
