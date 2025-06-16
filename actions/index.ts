import { Action } from './types';
import { typeAction } from './type';
import { pressKeyAction } from './press_key';
import { askAction } from './ask';

export const actions: Action[] = [
    typeAction,
    pressKeyAction,
    askAction
];  

export * from './types'; 