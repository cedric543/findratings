// listens for the user to click the save button
document.getElementById('save').addEventListener('click', () => {
  // grabs whatever text they pasted into the input box
  const key = document.getElementById('apiKey').value.trim();
  
  // saves the key into chrome storage so it stays there even if they close chrome
  chrome.storage.local.set({ omdb_key: key }, () => {
    const status = document.getElementById('status');
    status.textContent = 'key saved! you can now use the extension.';
    
    // clears the success message after 3 seconds so the screen looks clean again
    setTimeout(() => { status.textContent = ''; }, 3000);
  });
});

// when the user opens the settings page this pulls the existing key and puts it in the box
chrome.storage.local.get('omdb_key', (data) => {
  if (data.omdb_key) document.getElementById('apiKey').value = data.omdb_key;
});