/*
 * WaniKani's Item Info panel is the "F" hotkey. Its toggle is an anchor with
 * data-item-info-target="toggle"; additional_content_controller marks it open
 * with .additional-content__item--open and refuses to act while it still
 * carries .additional-content__item--disabled (which item_info_controller
 * only removes once an answer has been submitted).
 *
 * WaniKani also has its own auto-open setting, so check the open state before
 * clicking - otherwise we would toggle the panel back shut.
 */
export function openItemInfo() {
  const toggle = document.querySelector<HTMLElement>('[data-item-info-target="toggle"]');
  if (!toggle) return;
  if (toggle.classList.contains('additional-content__item--disabled')) return;
  if (!toggle.classList.contains('additional-content__item--open')) {
    toggle.click();
  }
  expandItemInfoSections();
}

/*
 * Sections inside the frame only auto-expand when they match the question type
 * you were just asked (meaning sections on meaning questions, and so on), so
 * after a miss the reading and explanation are usually still collapsed. The
 * frame loads over the network, hence the short poll.
 */
export function expandItemInfoSections(attempt = 0) {
  const frame = document.getElementById('subject-info');
  if (!frame) return;
  const collapsedSections = frame.querySelectorAll<HTMLElement>(
    '.subject-section--collapsible:not([expanded]) [data-toggle-target="toggle"]'
  );
  collapsedSections.forEach((toggle) => toggle.click());

  // Nothing rendered yet - try again while the turbo-frame is still loading.
  if (!frame.querySelector('.subject-section') && attempt < 20) {
    setTimeout(() => expandItemInfoSections(attempt + 1), 100);
  }
}
