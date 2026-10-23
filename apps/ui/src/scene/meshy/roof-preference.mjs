export function createRoofPreference(storage){
 let mode='full';try{if(storage?.getItem('den.roof-mode')==='cutaway')mode='cutaway';}catch{}
 return {get mode(){return mode;},set(value){if(!['full','cutaway'].includes(value))return;mode=value;try{storage?.setItem('den.roof-mode',value);}catch{}}};
}
