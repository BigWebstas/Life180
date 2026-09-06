//
// i18n
//


export let currentLang = 'en'; // default language

let translations = {};

export async function loadTranslations(lang) {
    try {
        const response = await fetch(`locales/${lang}.json`);
        if (!response.ok)
            throw new Error(`Translation not found for ${lang}`);
        translations = await response.json();
        currentLang = lang;
        updateTexts(); // update the page texts only when translations load
    } catch (error) {
        console.error(`Error loading translations for ${lang}.`, error);

        if (lang === 'en') {
            console.error("The English translation file could not be loaded. No changes will be made to the texts.");
            return; // do nothing if English is not found
        } else {
            console.error("Trying to load english as fallback.");
            await loadTranslations('en'); // try English as a fallback
        }
    }
}

export function t(key) {
    return translations[key] || key; // return the translation, or the original key if missing
}

export function tWithVars(key, vars = {}) {
    let text = t(key);
    for (const [varName, value] of Object.entries(vars)) {
        text = text.replace(`{${varName}}`, value);
    }
    return text;
}

function updateTexts() {
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        element.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        const key = element.getAttribute('data-i18n-placeholder');
        const translated = t(key);
        if (translated && translated !== key)
            element.placeholder = translated;
    });
}

export async function initializeI18n() {
    const userLang = navigator.language.slice(0, 2); // browser language

    // Set the `lang` attribute on the HTML document
    document.documentElement.setAttribute('lang', userLang);

    // Try to load the browser language
    await loadTranslations(userLang);
}
