import {ApplicationRef, ChangeDetectorRef, ElementRef, EventEmitter, Injectable, NgZone} from '@angular/core';
import {message, confirm} from "@tauri-apps/api/dialog";
import {HttpClient} from "@angular/common/http";
import Mousetrap from 'mousetrap';
import {CdkTextareaAutosize} from "@angular/cdk/text-field";
import {FavoriteDatabase, AskFavoriteListItem, FavoriteModel, AskFavoriteList} from "./app.model";
import {handleIsTauri} from "../main";
import config from '../../src-tauri/tauri.conf.json';
import {ModalService} from "../component/modal/modal.service";
import {ChatGptTokensUtil} from "../utils/chatGptTokens.util";
import {PlatformUtilService} from "../utils/platform.util";
import {HtmlUtilService} from "../utils/html.util";
import {MessageCardService} from "../component/message_card/messageCard.service";

export enum TAB_STATE {
    FAVORITE_MODE,
    ASK_MODE
}

export enum STREAM_STATE {
    PENDING,
    APPENDING,
    DONE,
    FAIL
}

export enum HISTORY_LIST_ITEM_STATE {
    PENDING,
    FINISH,
    FAIL
}

export enum HISTORY_LIST_ITEM_TYPE {
    'ANSWER' = 'answer',
    'QUESTION' = 'question',
}

export interface HistoryListItem {
    id: string,
    type: HISTORY_LIST_ITEM_TYPE,
    data: string | undefined,
    state: HISTORY_LIST_ITEM_STATE,
    updateTime: number;
}

export type HistoryList = HistoryListItem[];


export interface HistorySearchKeyListItem {
    key: string;
    selected: boolean;
    state: HISTORY_LIST_ITEM_STATE;
}

export type HistorySearchKeyList = HistorySearchKeyListItem[];

export interface AskContextItem {
    content: string,
    role: string
}


type AskContextList = AskContextItem[];


@Injectable({providedIn: 'root'})
export class AppService {

    public worker = new Worker(new URL('./app.worker', import.meta.url));

    public version = config.package.version;
    public isPromptMode = false;

    public favoriteDb = new FavoriteDatabase();

    public askSendResultEvent = new EventEmitter();

    public requestHtmlChuckEvent = new EventEmitter();

    public tabState: TAB_STATE = TAB_STATE.ASK_MODE;
    public favoriteList: AskFavoriteListItem[] = [];


    public favoriteCount: number = 0;
    public appKey = localStorage.getItem('APP-KEY');
    public searchKey = '';
    public isOpenSettingPanel = false;
    public isOpenHistorySearchListPanel = false;
    public updateAppKeyHandleTimer: any;
    public appKeyWidgetRef: ElementRef<HTMLTextAreaElement> | undefined;
    public searchWidgetRef: ElementRef<HTMLInputElement> | undefined;
    public historyElementRef: ElementRef<HTMLElement> | undefined;
    public autosizeRef: CdkTextareaAutosize | undefined;
    public HistorySearchKeyListSelectedIndex = 0;
    public historySearchKeyList: HistorySearchKeyList = [];
    public askList: AskFavoriteList = [];

    public newTempDataAppEndState: STREAM_STATE = STREAM_STATE.DONE;
    public newTempDataError = '';
    public newTempDataQuestionContent = '';

    public askContext: AskContextList = [];
    public enableAskContext = false;

    constructor(
        public modalService: ModalService,
        public favoriteModel: FavoriteModel,
    ) {
        this.appKey = localStorage.getItem('APP-KEY') || '';
        this.initShortcutKeyBind();
        this.initHistorySearchKeyList();
        this.initFavorite();
        this.initAskContext();
        this.initWorkerMessageListen();
    }

    public initWorkerMessageListen() {

        this.worker.addEventListener('message', ({data}) => {
            // chunk开始
            if (data.eventName === 'responseChunkStart') {
                this.searchKey = '';
                this.newTempDataAppEndState = STREAM_STATE.APPENDING;
            }
            // chunk结束
            if (data.eventName === 'responseChunkEnd') {
                this.searchKey = '';
                this.newTempDataAppEndState = STREAM_STATE.DONE;
                const {key, mdChunk, questionContent} = data.message;
                this.updateHistorySearchKeyList({
                    key: questionContent,
                    state: HISTORY_LIST_ITEM_STATE.FINISH,
                    selected: false
                });
                this.updateAskList(key, mdChunk, questionContent, HISTORY_LIST_ITEM_STATE.FINISH, STREAM_STATE.DONE);
                this.askSendResultEvent.emit();
            }
            // chunk 错误
            if (data.eventName === 'responseError') {
                this.searchKey = '';
                const {key, errorContent, questionContent} = data.message;
                this.newTempDataAppEndState = STREAM_STATE.DONE;
                this.updateAskList(key, errorContent, questionContent, HISTORY_LIST_ITEM_STATE.FAIL, STREAM_STATE.DONE);
            }
        })
    }


    // 每次有答案返回时，将容器的滚动条滚动至最底部
    // public moveHistoryContainerScrollToBottom() {
    //     setTimeout(() => {
    //         this.historyElementRef?.nativeElement.scrollTo({behavior: 'smooth', top: 999999999})
    //     }, 200);
    // }

    public initAskContext() {
        this.enableAskContext = localStorage.getItem('ENABLE-ASK-CONTEXT') === '1' || false;
    }

    // 初始化快捷键绑定
    public initShortcutKeyBind() {
        Mousetrap.bind('command+f', () => {
            this.searchWidgetRef?.nativeElement.focus();
        });
    }

    // 初始化历史搜索关键字列表（从本地存储读取至内存中）
    public initHistorySearchKeyList() {
        const historySearchKeyList = localStorage.getItem('HISTORY-SEARCH-KEY-LIST');
        if (historySearchKeyList) {
            try {
                this.historySearchKeyList = JSON.parse(historySearchKeyList);
            } catch (err) {
            }
        }
    }

    // 更新密钥,将密钥写入本地存储
    updateAppKeyHandle(value: string) {
        this.appKey = value.trim();
        this.updateAppKeyHandleTimer = setTimeout(() => {
            localStorage.setItem('APP-KEY', this.appKey!);
        }, 500);
    }

    // 验证是否有配置密钥，如若没有将弹出tauri提供的原生弹窗
    public async checkConfigAppKey() {
        let ok = true;
        if (!this.appKey) {
            if (handleIsTauri()) {
                await message(`未配置GPT密钥，请先配置GPT密钥`, {type: 'warning', title: 'GPT-GUI'});
                this.isOpenSettingPanel = true;
            } else {
                this.modalService.create(`未配置GPT密钥，请先配置GPT密钥`, {
                    confirm: () => {
                        this.isOpenSettingPanel = true;
                    }
                });
            }
            ok = false;
            setTimeout(() => {
                this.appKeyWidgetRef?.nativeElement?.focus();
            }, 100);
        }
        return ok;
    }

    // 清理搜索关键字（一般在发送问题之后）
    public clearSearchKey() {
        this.searchKey = '';
        this.autosizeRef?.reset();
    }

    // 更新问题集合
    public updateAskList(key: string, answerMarkdown: string | undefined, questionContent: string | undefined, state: HISTORY_LIST_ITEM_STATE, streamState: STREAM_STATE) {
        const findIndex = this.askList.findIndex((item) => item.key === key);
        const updateTime = new Date().getTime();

        if (findIndex > -1) {
            this.askList[findIndex].state = state;
            this.askList[findIndex].updateTime = updateTime;
            this.askList[findIndex].answerMarkdown = (this.askList[findIndex].answerMarkdown! || '') + (answerMarkdown || '');
            this.askList[findIndex].streamDone = streamState;
            // this.askList[findIndex].sn = sn;
        } else if (questionContent) {
            this.askList.push({
                key,
                state,
                streamDone: STREAM_STATE.APPENDING,
                questionContent,
                answerMarkdown,
                updateTime,
                inputTime: new Date().getTime()
            })
        }
        // this.moveHistoryContainerScrollToBottom();
    }


    // 更新历史搜索关键字
    public updateHistorySearchKeyList(item: HistorySearchKeyListItem) {

        this.historySearchKeyList.some((item, index) => {
            if (item.selected) {
                this.historySearchKeyList[index].selected = false;
                this.HistorySearchKeyListSelectedIndex = 0;
                return true;
            } else {
                return false;
            }
        })

        // 存在相同的
        if (this.historySearchKeyList.find((_item) => _item.key === item.key)) {
            return;
        }

        // 只保留最近的5条记录
        if (this.historySearchKeyList.length > 5) {
            this.historySearchKeyList = this.historySearchKeyList.reverse().splice(0, 5).reverse();
        }

        // 将历史搜索关键字同步至本地存储
        this.historySearchKeyList.push(item);
        localStorage.setItem('HISTORY-SEARCH-KEY-LIST', JSON.stringify(this.historySearchKeyList));

    }


    // 支持使用键盘上下箭头来选择历史搜索关键字记录
    public updateHistorySearchKeyListSelectedIndex(code: string) {

        // 如果没有历史搜索关键词时，将跳出
        if (this.historySearchKeyList.length === 0) {
            return;
        }

        // 每一次使用历史搜索都重置上次的选中状态
        this.historySearchKeyList.map((item, index) => {
            this.historySearchKeyList[index].selected = false;
        });

        // 初次默认打开搜索面板
        if (!this.isOpenHistorySearchListPanel && this.historySearchKeyList.length > 0) {
            this.HistorySearchKeyListSelectedIndex = this.historySearchKeyList.length - 1;
            this.isOpenHistorySearchListPanel = true;
            this.historySearchKeyList[this.HistorySearchKeyListSelectedIndex].selected = true;
            return;
        }

        if (code === 'ArrowUp') {
            this.HistorySearchKeyListSelectedIndex = this.HistorySearchKeyListSelectedIndex - 1;
        }

        if (code === 'ArrowDown') {
            this.HistorySearchKeyListSelectedIndex = this.HistorySearchKeyListSelectedIndex + 1;
        }

        if (this.HistorySearchKeyListSelectedIndex === -1) {
            this.HistorySearchKeyListSelectedIndex = 0;
        }

        if (this.HistorySearchKeyListSelectedIndex >= this.historySearchKeyList.length) {
            this.HistorySearchKeyListSelectedIndex = this.historySearchKeyList.length - 1;
        }

        if (this.historySearchKeyList[this.HistorySearchKeyListSelectedIndex]) {
            this.historySearchKeyList[this.HistorySearchKeyListSelectedIndex].selected = true;
        }

    }

    //清理历史搜索记录
    cleanHistorySearchKeyList(event: MouseEvent) {
        event.stopPropagation();
        event.preventDefault();
        this.isOpenHistorySearchListPanel = false;
        this.historySearchKeyList = [];
        this.HistorySearchKeyListSelectedIndex = 0;
        localStorage.removeItem('HISTORY-SEARCH-KEY-LIST');
    }

    public async initFavorite() {
        await this.getFavoriteCount();
    }

    public async getFavorite() {
        const response = await this.favoriteModel.getList();
        this.favoriteList = response;
    }

    public async getFavoriteCount() {
        setTimeout(async () => {
            this.favoriteCount = await this.favoriteModel.getListCount();
        }, 200)
    }

    public async deleteFavorite(id: number | undefined) {

        if (!id) {
            if (handleIsTauri()) {
                await message('缺少必要的删除id', {title: '', type: 'info'});
            } else {
                this.modalService.create(`缺少必要的删除id`, {
                    confirm: () => {
                        this.isOpenSettingPanel = true;
                    }
                });
            }

            return;
        }

        if ((await this.favoriteModel.favoriteDB.favorite.where({id}).count()) !== 0) {
            await this.favoriteModel.delete(id);
            await this.getFavorite();
            await this.getFavoriteCount();
        } else {
            if (handleIsTauri()) {
                await message('无效的删除ID', {title: '', type: 'info'});
            } else {
                this.modalService.create('无效的删除ID');
            }

        }

    }

    public async favoriteHandle(item: AskFavoriteListItem) {
        const data: AskFavoriteListItem = {
            key: item.key!,
            id: item.id!,
            state: item.state,
            questionContent: item.questionContent,
            answerContent: item.answerContent,
            answerMarkdown: item.answerMarkdown,
            updateTime: item.updateTime,
            inputTime: item.inputTime,
            streamDone: STREAM_STATE.DONE
        };
        if ((await this.favoriteModel.favoriteDB.favorite.where({questionContent: item.questionContent}).count()) !== 0) {
            if (handleIsTauri()) {
                await message('该问题已收藏过', {title: '', type: 'info'});
            } else {
                this.modalService.create('该问题已收藏过');
            }

            return;
        }
        await this.favoriteModel.add(data);
        await this.getFavoriteCount();
        if (handleIsTauri()) {
            await message('收藏成功', {title: '', type: 'info'});
        } else {
            this.modalService.create('收藏成功');
        }

    }

    public async switchAskContextEnableStateHandle() {

        if (handleIsTauri()) {
            const confirmed = await confirm('确定切换上下文状态吗？开启上下文后Chat GTP将会更好的结合你上次的问题与答案，聊天体验将会变得更好，但同时也更加耗费Tokens。', 'GPT-GUI');
            if (confirmed) {
                this.askContext = [];
                if (this.enableAskContext) {
                    this.enableAskContext = false;
                    this.askContext = [];
                    localStorage.setItem('ENABLE-ASK-CONTEXT', '0')
                } else {
                    this.enableAskContext = true;
                    localStorage.setItem('ENABLE-ASK-CONTEXT', '1')
                }
            }
        } else {
            this.modalService.create(`确定切换上下文状态吗？开启上下文后Chat GTP将会更好的结合你上次的问题与答案，聊天体验将会变得更好，但同时也更加耗费Tokens。`, {
                confirm: () => {
                    this.askContext = [];
                    if (this.enableAskContext) {
                        this.enableAskContext = false;
                        this.askContext = [];
                        localStorage.setItem('ENABLE-ASK-CONTEXT', '0')
                    } else {
                        this.enableAskContext = true;
                        localStorage.setItem('ENABLE-ASK-CONTEXT', '1')
                    }
                },
                cancel: () => {

                }
            });
        }

    }

    public async tabStateChange(state: TAB_STATE) {
        this.tabState = state;
        if (state === TAB_STATE.FAVORITE_MODE) {
            await this.getFavorite();
            await this.getFavoriteCount();
        }
    }

    public get sortAskList() {
        let askList = this.askList;
        return askList.sort((itemA, itemB) => {
            return itemA.inputTime! - itemB.inputTime!
        });
    }

    public get sortFavoriteList() {
        let favoriteList = this.favoriteList;
        return favoriteList.sort((itemA, itemB) => {
            if (!itemB.inputTime || !itemA.inputTime) {
                return 1;
            }
            return itemB.inputTime - itemA.inputTime;
        });
    }

    // 清理上下文信息
    public async cleanAskContextHandle() {
        if (handleIsTauri()) {
            const confirmed = await confirm('与Chat GTP聊天时，有上下文它可以更好的理解你的问题，确认要清理上下文吗？', 'GPT-GUI');
            if (confirmed) {
                this.askContext = [];
            }
        } else {
            this.modalService.create(`与Chat GTP聊天时，有上下文它可以更好的理解你的问题，确认要清理上下文吗？`, {
                confirm: () => {
                    this.askContext = [];
                },
                cancel: () => {

                }
            });
        }
    }

    // 获取上下文token相关信息
    get askContextInfo() {
        let contextObj = {
            totalTokensLen: 0,
            questionCount: 0,
            answerCount: 0,
            tempQuestionTokenLen: ChatGptTokensUtil.tokenLen(this.searchKey),
        };
        // ChatGptTokensUtil
        let str = '';
        this.askContext.map((item) => {
            str += item.content;
            if (item.role === 'user') {
                contextObj.questionCount++
            } else {
                contextObj.answerCount++
            }
        });

        contextObj.totalTokensLen = ChatGptTokensUtil.tokenLen(str.replace(/\n/g, ''));

        return contextObj;
    }

    public generateContext() {
        const askContext: AskContextList = [];
        if (this.enableAskContext) {
            if (this.askList && this.askList.length > 0) {
                const descAskList = this.askList.sort((itemA, itemB) => {
                    return itemA.inputTime! - itemB.inputTime!;
                });
                descAskList.map((item) => {
                    if (item.state !== HISTORY_LIST_ITEM_STATE.FAIL) {
                        if (item.questionContent) {
                            askContext.push({content: item.questionContent, role: 'user'});
                        }
                        if (item.answerMarkdown) {
                            askContext.push({content: item.answerMarkdown, role: 'assistant'});
                        }
                    }
                });
            }
        }
        askContext.push({content: this.searchKey, role: 'user'});
        return askContext;
    }

    // 发送
    public async send() {

        // 不是done状态将不允许发送下一条记录
        if (this.newTempDataAppEndState !== STREAM_STATE.DONE) {
            return;
        }

        // 如果缺少秘钥
        if (!await this.checkConfigAppKey()) {
            return;
        }

        // 如果未输入搜索关键词
        if (!this.searchKey) {
            return;
        }

        this.isPromptMode = false;
        // const address = 'http://localhost:6200/q/2';
        const address = 'https://chatgpt.kka.pw/q/2';
        const timestamp = new Date().getTime();
        const id = `ASK-${timestamp}`;
        // 生成上下文
        this.askContext = this.generateContext();
        this.newTempDataAppEndState = STREAM_STATE.PENDING;
        this.newTempDataQuestionContent = this.searchKey;
        this.askSendResultEvent.emit();

        this.worker.postMessage({
            eventName: 'request',
            message: {
                key: id,
                address,
                questionContent: this.searchKey,
                appKey: this.appKey,
                askContext: this.askContext
            }
        });
    }
}
