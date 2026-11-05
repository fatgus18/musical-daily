export const CONTRAST_STORAGE_KEY = "musical-daily:contrast:v1";
export const CONTRAST_COOKIE = "md_contrast";

// Runs in the document head before the page paints. Only a validated enum is
// read; no account data is stored here. A host cookie shares it across app ports.
export const contrastBootstrap = `(function(){var v;try{v=document.cookie.split('; ').find(function(c){return c.indexOf('md_contrast=')===0});v=v&&v.slice(12)}catch(e){}if(v!=='high'&&v!=='standard'){try{v=localStorage.getItem('musical-daily:contrast:v1')}catch(e){}}if(v!=='high'&&v!=='standard'){v=window.matchMedia('(prefers-contrast: more)').matches?'high':'standard'}document.documentElement.dataset.contrast=v})()`;
