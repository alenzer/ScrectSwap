import React, { CSSProperties } from 'react';
import { CosmWasmClient, ExecuteResult } from 'secretjs';
import { Button, Container } from 'semantic-ui-react';
import { canonicalizeBalance, displayHumanizedBalance, humanizeBalance, sortedStringify, UINT128_MAX } from 'utils';
import styles from './styles.styl';
import { SwapAssetRow } from '../SwapAssetRow/SwapAssetRow';
import { TabsHeader } from './TabsHeader';
import { PriceRow } from '../../components/Swap/PriceRow';
import { UserStoreEx } from 'stores/UserStore';
import { Coin } from 'secretjs/types/types';
import BigNumber from 'bignumber.js';
import { compareNormalize, shareOfPoolNumberFormat, storeTxResultLocally } from './utils';
import { extractError, GetContractCodeHash, getFeeForExecute } from '../../blockchain-bridge';
import { CreateNewPair } from '../../blockchain-bridge/scrt/swap';
import { Asset } from '../TokenModal/types/trade';
import { SwapTokenMap } from '../TokenModal/types/SwapToken';
import { FlexRowSpace } from '../../components/Swap/FlexRowSpace';
import cn from 'classnames';
import { PairMap, SwapPair } from '../TokenModal/types/SwapPair';
import { PairAnalyticsLink } from '../../components/Swap/PairAnalyticsLink';
import { ApproveButton } from '../../components/Swap/ApproveButton';
import { SwapPlus } from '../../components/Swap/SwapPlus';
import { NewPoolWarning } from '../../components/Swap/NewPoolWarning';
import { AsyncSender } from '../../blockchain-bridge/scrt/asyncSender';
import { useStores } from 'stores';
import Theme from 'themes';
import { observer } from 'mobx-react';
import { GAS_FOR_APPROVE, GAS_FOR_PROVIDE } from '../../utils/gasPrices';

enum TokenSelector {
  TokenA,
  TokenB,
}

// const BUTTON_MSG_ENTER_AMOUNT = 'Enter an amount';
// const BUTTON_MSG_NO_TRADNIG_PAIR = ;
// const BUTTON_MSG_LOADING_PRICE =
// const BUTTON_MSG_PROVIDE = 'Provide';

enum ProvideState {
  READY,
  LOADING,
  PAIR_NOT_EXIST,
  WAITING_FOR_INPUT,
  INSUFFICIENT_A_BALANCE,
  INSUFFICIENT_B_BALANCE,
  PAIR_LIQUIDITY_ZERO,
  UNLOCK_TOKENS,
  CREATE_NEW_PAIR,
  CANNOT_CREAT_SCRT_PAIR,
}

const ButtonMessage = (state: ProvideState): string => {
  switch (state) {
    case ProvideState.INSUFFICIENT_A_BALANCE:
      return 'Insufficient Balance';
    case ProvideState.INSUFFICIENT_B_BALANCE:
      return 'Insufficient Balance';
    case ProvideState.LOADING:
      return 'Select a token';
    case ProvideState.PAIR_LIQUIDITY_ZERO:
      return 'Add Initial Liquidity';
    case ProvideState.PAIR_NOT_EXIST:
      return 'Trading pair does not exist';
    case ProvideState.READY:
      return 'Provide';
    case ProvideState.WAITING_FOR_INPUT:
      return 'Enter an Amount';
    case ProvideState.UNLOCK_TOKENS:
      return 'Unlock Tokens';
    case ProvideState.CREATE_NEW_PAIR:
      return 'Create New Pair';
    case ProvideState.CANNOT_CREAT_SCRT_PAIR:
      return 'Cannot Create New SCRT Pairs';
    default:
      return 'Provide';
  }
};
@observer
export class ProvideTab extends React.Component<
  {
    user: UserStoreEx;
    secretjs: CosmWasmClient;
    secretjsSender: AsyncSender;
    tokens: SwapTokenMap;
    balances: {
      [symbol: string]: BigNumber | JSX.Element;
    };
    pairs: PairMap;
    selectedPair: SwapPair;
    selectedToken0: string;
    selectedToken1: string;
    notify: (type: 'success' | 'error', msg: string, closesAfterMs?: number) => void;
    onSetTokens: CallableFunction;
    theme: Theme;
  },
  {
    tokenA: string;
    tokenB: string;
    inputA: string;
    inputB: string;
    isEstimatedA: boolean;
    isEstimatedB: boolean;
    allowanceA: BigNumber;
    allowanceB: BigNumber;
    buttonMessage: string;
    loadingProvide: boolean;
    loadingApproveA: boolean;
    loadingApproveB: boolean;
    provideState: ProvideState;
  }
> {
  constructor(props) {
    super(props);

    this.state = {
      tokenA: this.props.selectedToken0 || this.props.tokens.values().next()?.value?.identifier || '',
      tokenB: this.props.selectedToken1 || '',
      inputA: '',
      inputB: '',
      allowanceA: new BigNumber(0),
      allowanceB: new BigNumber(0),
      isEstimatedA: false,
      isEstimatedB: false,
      buttonMessage: '',
      loadingProvide: false,
      loadingApproveA: false,
      loadingApproveB: false,
      provideState: ProvideState.UNLOCK_TOKENS,
    };
  }

  componentDidMount() {
    if (this.props.selectedPair) {
      const [tokenA, tokenB] = this.props.selectedPair.assetIds();
      this.setState({ tokenA, tokenB }, () => {
        this.updateAllowance(tokenA);
        this.updateAllowance(tokenB);
      });
    }
  }

  componentDidUpdate(previousProps) {
    if (sortedStringify(previousProps.balances) !== sortedStringify(this.props.balances)) {
      this.updateInputs();
    }

    if (this.props.selectedPair && previousProps.selectedPair !== this.props.selectedPair) {
      const [tokenA, tokenB] = this.props.selectedPair.assetIds();
      this.setState(
        {
          tokenA,
          tokenB,
        },
        () => {
          this.updateAllowance(tokenA);
          this.updateAllowance(tokenB);
        },
      );
    }

    const newProvideState = this.getProvideState(this.props.selectedPair);
    if (newProvideState !== this.state.provideState) {
      this.setState({ provideState: newProvideState });
    }
  }

  private getTokenBalances(): (BigNumber | JSX.Element)[] {
    return [this.props.balances[this.state.tokenA], this.props.balances[this.state.tokenB]];
  }

  private getDecimalsB(): number {
    return this.props.tokens.get(this.state.tokenB)?.decimals;
  }

  private getDecimalsA(): number {
    return this.props.tokens.get(this.state.tokenA)?.decimals;
  }

  async updateAllowance(symbol: string) {
    if (!this.props.selectedPair) {
      //console.error('updateAllowance for non-existent pair');
      return;
    }

    let stateField: string;
    if (this.state.tokenA === symbol) {
      stateField = 'allowanceA';
    } else if (this.state.tokenB === symbol) {
      stateField = 'allowanceB';
    } else {
      console.error('updateAllowance for non-selected token', symbol);
      return;
    }

    if (symbol === 'uscrt') {
      this.setState<never>({ [stateField]: new BigNumber(Infinity) });
      return;
    }

    const result: {
      allowance: {
        owner: string;
        spender: string;
        allowance: string;
        expiration: number;
      };
    } = await this.props.secretjs.queryContractSmart(this.props.tokens.get(symbol).address, {
      allowance: {
        owner: this.props.user.address,
        spender: this.props.selectedPair.contract_addr,
        key: 'SecretSwap',
      },
    });

    let allowance = new BigNumber(result.allowance.allowance);
    if (allowance.isNaN()) {
      allowance = new BigNumber(0);
    }

    console.log(`Allowance for ${symbol} is ${allowance} (${result.allowance.allowance})`);

    this.setState<never>({ [stateField]: allowance });
  }

  async updateInputs() {
    if (!this.props.selectedPair) {
      this.setState({
        inputA: '',
        isEstimatedA: false,
        inputB: '',
        isEstimatedB: false,
      });
      return;
    }

    const humanPoolA = humanizeBalance(this.getPoolA(), this.getDecimalsA());
    const humanPoolB = humanizeBalance(this.getPoolB(), this.getDecimalsB());

    if (humanPoolA.isNaN() || humanPoolB.isNaN()) {
      this.setState({
        inputA: '',
        isEstimatedA: false,
        inputB: '',
        isEstimatedB: false,
      });
      return;
    }
    if (humanPoolA.isEqualTo(0) || humanPoolB.isEqualTo(0)) {
      return;
    }

    if (this.state.isEstimatedB) {
      // inputB/inputA = poolB/poolA
      // =>
      // inputB = inputA*(poolB/poolA)
      const inputB = Number(this.state.inputA) * humanPoolB.dividedBy(humanPoolA).toNumber();

      if (isNaN(inputB) || this.state.inputA === '') {
        this.setState({
          isEstimatedA: false,
          inputB: '',
          isEstimatedB: false,
        });
      } else {
        const nf = new Intl.NumberFormat('en-US', {
          maximumFractionDigits: this.getDecimalsB(),
          useGrouping: false,
        });
        this.setState({
          inputB: inputB < 0 ? '' : nf.format(inputB),
          isEstimatedB: inputB >= 0,
        });
      }
    } else if (this.state.isEstimatedA) {
      // inputA/inputB = poolA/poolB
      // =>
      // inputA = inputB*(poolA/poolB)
      const inputA = Number(this.state.inputB) * humanPoolA.dividedBy(humanPoolB).toNumber();

      if (isNaN(inputA) || this.state.inputB === '') {
        this.setState({
          isEstimatedB: false,
          inputA: '',
          isEstimatedA: false,
        });
      } else {
        const nf = new Intl.NumberFormat('en-US', {
          maximumFractionDigits: this.getDecimalsA(),
          useGrouping: false,
        });
        this.setState({
          isEstimatedB: false,
          inputA: inputA < 0 ? '' : nf.format(inputA),
          isEstimatedA: inputA >= 0,
        });
      }
    }
  }

  async approveOnClick(pair: SwapPair, tokenAddress: string) {
    let stateFieldSuffix: string;
    if (this.state.tokenA === tokenAddress) {
      stateFieldSuffix = 'A';
    } else if (this.state.tokenB === tokenAddress) {
      stateFieldSuffix = 'B';
    } else {
      console.error('approveOnClick for non-selected token', tokenAddress);
      return;
    }

    this.setState<never>({
      [`loadingApprove${stateFieldSuffix}`]: true,
    });

    try {
      const tx = await this.props.secretjsSender.asyncExecute(
        tokenAddress,
        {
          increase_allowance: {
            spender: pair.contract_addr,
            amount: UINT128_MAX,
          },
        },
        '',
        [],
        getFeeForExecute(GAS_FOR_APPROVE),
      );
      storeTxResultLocally(tx);

      this.setState<never>({
        [`allowance${stateFieldSuffix}`]: new BigNumber(Infinity),
      });
      await this.props.user.updateScrtBalance();
      this.props.notify(
        'success',
        `${this.props.tokens.get(tokenAddress).symbol} approved for ${this.props.selectedPair.humanizedSymbol()}`,
      );
    } catch (error) {
      console.error('Error while trying to approve', tokenAddress, error);
      this.props.notify('error', `Error approving ${tokenAddress}: ${error.message}`);
    }

    this.setState<never>({
      [`loadingApprove${stateFieldSuffix}`]: false,
    });
  }

  getProvideState(pair: SwapPair): ProvideState {
    const [balanceA, balanceB] = this.getTokenBalances();
    const decimalsA = this.getDecimalsA();
    const decimalsB = this.getDecimalsB();

    if (!(this.state.tokenB && this.state.tokenA)) {
      return ProvideState.LOADING;
    }

    if (!pair && (this.state.tokenB === 'uscrt' || this.state.tokenA === 'uscrt')) {
      return ProvideState.CANNOT_CREAT_SCRT_PAIR;
    } else if (!pair) {
      return ProvideState.CREATE_NEW_PAIR;
    } else if (this.getPoolA().isNaN() || this.getPoolB().isNaN()) {
      return ProvideState.LOADING;
    } else if (this.getPoolA().isZero() && this.getPoolB().isZero()) {
      return ProvideState.PAIR_LIQUIDITY_ZERO;
    } else if (this.state.inputA === '' || this.state.inputB === '') {
      return ProvideState.WAITING_FOR_INPUT;
    } else if (!(balanceA instanceof BigNumber && balanceB instanceof BigNumber)) {
      return ProvideState.READY;
    } else if (compareNormalize(this.state.inputA, { amount: balanceA, decimals: decimalsA })) {
      return ProvideState.INSUFFICIENT_A_BALANCE;
    } else if (compareNormalize(this.state.inputB, { amount: balanceB, decimals: decimalsB })) {
      return ProvideState.INSUFFICIENT_B_BALANCE;
    } else {
      return ProvideState.READY;
    }
  }

  render() {
    const pairSymbol = this.props.selectedPair?.lpTokenSymbol().replace('LP-', '');

    const buttonMessage = ButtonMessage(this.state.provideState);

    const [balanceA, balanceB] = this.getTokenBalances();

    const decimalsA = this.getDecimalsA();
    const decimalsB = this.getDecimalsB();

    const poolA = this.getPoolA();
    const poolB = this.getPoolB();

    const price = this.getPrice();

    const amountA = canonicalizeBalance(new BigNumber(this.state.inputA), decimalsA);
    const amountB = canonicalizeBalance(new BigNumber(this.state.inputB), decimalsB);

    const showApproveAButton: boolean =
      this.state.tokenA !== 'uscrt' && this.props.selectedPair && this.state.allowanceA.lt(amountA);
    const showApproveBButton: boolean =
      this.state.tokenB !== 'uscrt' && this.props.selectedPair && this.state.allowanceB.lt(amountB);

    const lpTokenBalance = this.props.balances[`LP-${this.props.selectedPair?.identifier()}`];
    const lpTokenTotalSupply = new BigNumber(
      this.props.balances[`${this.props.selectedPair?.liquidity_token}-total-supply`] as BigNumber,
    );
    const currentShareOfPool = lpTokenTotalSupply.isZero()
      ? lpTokenTotalSupply
      : new BigNumber(lpTokenBalance as BigNumber).dividedBy(lpTokenTotalSupply);

    const gainedShareOfPool = BigNumber.minimum(
      amountA.dividedBy(poolA.plus(amountA)),
      amountB.dividedBy(poolB.plus(amountB)),
    );
    const rowStyle: CSSProperties = {
      display: 'flex',
      padding: '0.5em 0 0 0',
      color: this.props.theme.currentTheme == 'light' ? '#5F5F6B' : '#DEDEDE',
      fontFamily: 'Poppins',
    };
    let lpShare = new BigNumber(0);
    let lpShareJsxElement = lpTokenBalance; // View Balance
    let pooledTokenA: string;
    let pooledTokenB: string;

    const lpTokenBalanceNum = new BigNumber(lpTokenBalance as BigNumber);
    if (!lpTokenBalanceNum.isNaN()) {
      if (lpTokenTotalSupply?.isGreaterThan(0)) {
        console.log('lpTokenBalanceNum');
        lpShare = lpTokenBalanceNum.dividedBy(lpTokenTotalSupply);

        pooledTokenA = displayHumanizedBalance(
          humanizeBalance(
            lpShare.multipliedBy(this.props.balances[`${this.state.tokenA}-${pairSymbol}`] as BigNumber),
            decimalsA,
          ),
        );

        pooledTokenB = displayHumanizedBalance(
          humanizeBalance(
            lpShare.multipliedBy(this.props.balances[`${this.state.tokenB}-${pairSymbol}`] as BigNumber),
            decimalsB,
          ),
        );

        lpShareJsxElement = (
          <span>{`${shareOfPoolNumberFormat.format(
            lpTokenBalanceNum
              .multipliedBy(100)
              .dividedBy(lpTokenTotalSupply)
              .toNumber(),
          )}%`}</span>
        );
      } else {
        pooledTokenA = '0';
        pooledTokenB = '0';
        lpShareJsxElement = <span>0%</span>;
      }
    }

    return (
      <Container className={`${styles.swapContainerStyle} ${styles[this.props.theme.currentTheme]}`}>
        <TabsHeader />
        <SwapAssetRow
          secretjs={this.props.secretjs}
          label="From"
          maxButton={true}
          balance={balanceA}
          tokens={this.props.tokens}
          token={this.state.tokenA}
          setToken={async (symbol: string) => {
            await this.setToken(symbol, TokenSelector.TokenA);
          }}
          amount={this.state.inputA}
          isEstimated={false}
          setAmount={(value: string) => {
            this.setAmount(value, TokenSelector.TokenA);
          }}
        />
        <div
          style={{
            padding: '1em',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <FlexRowSpace />
          <span>
            <SwapPlus />
          </span>
          <FlexRowSpace />
        </div>
        <SwapAssetRow
          secretjs={this.props.secretjs}
          label="To"
          maxButton={true}
          balance={balanceB}
          tokens={this.props.tokens}
          token={this.state.tokenB}
          setToken={async (symbol: string) => {
            await this.setToken(symbol, TokenSelector.TokenB);
          }}
          amount={this.state.inputB}
          isEstimated={false}
          setAmount={(value: string) => {
            this.setAmount(value, TokenSelector.TokenB);
          }}
        />
        {!price.isNaN() && (
          <PriceRow
            fromToken={this.props.tokens.get(this.state.tokenA)?.symbol}
            toToken={this.props.tokens.get(this.state.tokenB)?.symbol}
            price={price.toNumber()}
          />
        )}
        {lpTokenBalance !== undefined && (
          <>
            <div style={rowStyle}>
              <span>Your Total Pool Tokens</span>
              <FlexRowSpace />
              {lpTokenBalanceNum.isNaN()
                ? lpTokenBalance
                : displayHumanizedBalance(humanizeBalance(lpTokenBalanceNum, 6))}
            </div>
            {!lpTokenBalanceNum.isNaN() && (
              <>
                <div style={rowStyle}>
                  <span style={{ margin: 'auto' }}>{`Pooled ${this.props.tokens.get(this.state.tokenA)?.symbol}`}</span>
                  <FlexRowSpace />
                  <span style={{ margin: 'auto' }}>{pooledTokenA}</span>
                </div>
                <div style={rowStyle}>
                  <span style={{ margin: 'auto' }}>{`Pooled ${this.props.tokens.get(this.state.tokenB)?.symbol}`}</span>
                  <FlexRowSpace />
                  <span style={{ margin: 'auto' }}>{pooledTokenB}</span>
                </div>
              </>
            )}
            <div
              style={{
                display: 'flex',
                paddingTop: '0.5rem',
                color: this.props.theme.currentTheme == 'light' ? '#5F5F6B' : '#DEDEDE',
              }}
            >
              Your Current Share of Pool
              <FlexRowSpace />
              {(() => {
                if (JSON.stringify(lpTokenBalance).includes('View')) {
                  return lpTokenBalance;
                } else if (isNaN(currentShareOfPool.multipliedBy(100).toNumber())) {
                  return '-';
                } else {
                  return `${shareOfPoolNumberFormat.format(currentShareOfPool.multipliedBy(100).toNumber())}%`;
                }
              })()}
            </div>
          </>
        )}
        {!gainedShareOfPool.isNaN() && (
          <div
            style={{
              display: 'flex',
              paddingTop: '0.5rem',
              color: this.props.theme.currentTheme == 'light' ? '#5F5F6B' : '#DEDEDE',
            }}
          >
            Expected Gain in Your Share of Pool
            <FlexRowSpace />
            {`~${shareOfPoolNumberFormat.format(gainedShareOfPool.multipliedBy(100).toNumber())}%`}
          </div>
        )}
        <PairAnalyticsLink pairAddress={this.props.selectedPair?.contract_addr} />
        <div hidden={!this.showPoolWarning()}>
          <NewPoolWarning
            inputA={this.state.inputA}
            inputB={this.state.inputB}
            tokenA={this.props.tokens.get(this.state.tokenA)?.symbol}
            tokenB={this.props.tokens.get(this.state.tokenB)?.symbol}
          />
        </div>
        <div hidden={!showApproveAButton}>
          <ApproveButton
            disabled={this.state.loadingApproveA}
            loading={this.state.loadingApproveA}
            onClick={() => {
              this.approveOnClick(this.props.selectedPair, this.state.tokenA).then(() => {});
            }}
            token={this.props.tokens.get(this.state.tokenA)?.symbol}
          />
        </div>
        <div hidden={!showApproveBButton}>
          <ApproveButton
            disabled={this.state.loadingApproveB}
            loading={this.state.loadingApproveB}
            onClick={() => {
              this.approveOnClick(this.props.selectedPair, this.state.tokenB).then(() => {});
            }}
            token={this.props.tokens.get(this.state.tokenB)?.symbol}
          />
        </div>
        <Button
          disabled={
            this.state.loadingProvide ||
            (!this.isReadyForNewPool() &&
              (!this.isReadyForProvide() ||
                this.state.inputA === '' ||
                this.state.inputB === '' ||
                showApproveAButton ||
                showApproveBButton))
          }
          loading={this.state.loadingProvide}
          primary={
            (this.isReadyForProvide() || this.state.provideState === ProvideState.CREATE_NEW_PAIR) &&
            !showApproveAButton &&
            !showApproveBButton
          }
          fluid
          className={`${styles.provide_button} ${styles[this.props.theme.currentTheme]}`}
          onClick={async () => {
            if (this.isReadyForProvide()) {
              await this.provideLiquidityAction(this.props.selectedPair);
            } else if (this.isReadyForNewPool()) {
              const assetA = Asset.fromSwapToken(this.props.tokens.get(this.state.tokenA));
              const assetB = Asset.fromSwapToken(this.props.tokens.get(this.state.tokenB));

              this.setState({ loadingProvide: true });

              try {
                const result: any = await this.createNewPairAction(assetA, assetB);
                window.dispatchEvent(new Event('updatePairsAndTokens'));
                await this.props.user.updateScrtBalance();
                if (result.code) {
                  const error = extractError(result);
                  throw new Error(error);
                }
                this.props.notify('success', `${assetA.symbol}/${assetB.symbol} pair created successfully`);
              } catch (error) {
                this.props.notify('error', `Error creating pair ${assetA.symbol}/${assetB.symbol}: ${error.message}`);
              }

              this.setState({ loadingProvide: false });
            }
          }}
        >
          {buttonMessage}
        </Button>
      </Container>
    );
  }

  private setAmount(value: string, token: TokenSelector) {
console.log(value)
console.log(token)
    if (value === '') {
      this.setState(
        {
          inputA: token === TokenSelector.TokenA ? value : this.state.inputA,
          inputB: token === TokenSelector.TokenB ? value : this.state.inputB,
          isEstimatedA: false,
          isEstimatedB: false,
        },
        () => this.updateInputs(),
      );
      return;
    }

    this.setState(
      {
        inputA: token === TokenSelector.TokenA ? value : this.state.inputA,
        inputB: token === TokenSelector.TokenB ? value : this.state.inputB,
        isEstimatedA: token !== TokenSelector.TokenA,
        isEstimatedB: token !== TokenSelector.TokenB,
      },
      () => this.updateInputs(),
    );
  }

  private async setToken(symbol: string, token: TokenSelector) {
    if (token === TokenSelector.TokenA ? symbol === this.state.tokenB : symbol === this.state.tokenA) {
      // switch
      this.setState(
        {
          tokenA: this.state.tokenB,
          tokenB: this.state.tokenA,
          inputA: this.state.inputB,
          inputB: this.state.inputA,
          isEstimatedA: this.state.isEstimatedB,
          isEstimatedB: this.state.isEstimatedA,
          allowanceA: this.state.allowanceB,
          allowanceB: this.state.allowanceA,
        },
        () => {
          this.updateInputs();
          this.props.onSetTokens(this.state.tokenA, this.state.tokenB);
        },
      );
    } else {
      this.setState(
        {
          tokenA: token === TokenSelector.TokenA ? symbol : this.state.tokenA,
          tokenB: token === TokenSelector.TokenB ? symbol : this.state.tokenB,
          inputA: token === TokenSelector.TokenA ? '' : this.state.inputA,
          inputB: token === TokenSelector.TokenB ? '' : this.state.inputB,
          isEstimatedA: token === TokenSelector.TokenA,
          isEstimatedB: token === TokenSelector.TokenB,
        },
        () => {
          this.updateInputs();
          this.updateAllowance(token === TokenSelector.TokenA ? this.state.tokenA : this.state.inputB);
          this.props.onSetTokens(this.state.tokenA, this.state.tokenB);
        },
      );
    }
  }

  private isReadyForNewPool() {
    return this.state.provideState === ProvideState.CREATE_NEW_PAIR;
  }

  private async provideLiquidityAction(pair: SwapPair) {
    this.setState({ loadingProvide: true });

    const msg = {
      provide_liquidity: {
        assets: [],
      },
    };

    let transferAmount: Array<Coin> = [];
    for (const i of ['A', 'B']) {
      const { decimals } = this.props.tokens.get(this.state['token' + i]);

      const amount: string = canonicalizeBalance(new BigNumber(this.state['input' + i]), decimals).toFixed(
        0,
        BigNumber.ROUND_DOWN,
        /*
          should be 0 fraction digits because of canonicalizeBalance,
          but to be sure we're rounding down to prevent over-spending
          */
      );

      if (this.state['token' + i] === 'uscrt') {
        msg.provide_liquidity.assets.push({
          info: {
            native_token: {
              denom: 'uscrt',
            },
          },
          amount: amount,
        });
        transferAmount = [{ amount: amount, denom: 'uscrt' }];
      } else {
        const token = this.props.tokens.get(this.state['token' + i]);

        let token_code_hash = '';

        try {
          token_code_hash = await GetContractCodeHash({ secretjs: this.props.secretjs, address: token.address });
        } catch (error) {
          console.error('Error while trying to add liquidity', error);
          this.props.notify(
            'error',
            `Error providing to ${this.props.selectedPair.identifier()} - error getting token information`,
          );

          this.setState({ loadingProvide: false });

          return;
        }

        msg.provide_liquidity.assets.push({
          info: {
            token: {
              contract_addr: token.address,
              token_code_hash: token_code_hash,
              viewing_key: '',
            },
          },
          amount: amount,
        });
      }
    }
    const { inputA, inputB, tokenA, tokenB } = this.state;

    try {
      const tx = await this.props.secretjsSender.asyncExecute(
        pair.contract_addr,
        msg,
        '',
        transferAmount,
        getFeeForExecute(GAS_FOR_PROVIDE),
      );
      storeTxResultLocally(tx);

      this.props.notify(
        'success',
        `Provided ${inputA} ${this.props.tokens.get(tokenA).symbol} + ${inputB} ${
          this.props.tokens.get(tokenB).symbol
        }`,
      );

      this.setState({
        inputA: '',
        inputB: '',
        isEstimatedA: false,
        isEstimatedB: false,
      });

      await this.props.onSetTokens(this.props.selectedToken0, this.props.selectedToken1, true);
    } catch (error) {
      console.error('Error while trying to add liquidity', error);
      this.props.notify('error', `Error providing to ${tokenA}/${tokenB}: ${error.message}`);
    } finally {
      this.setState({ loadingProvide: false });
    }
  }

  private showPoolWarning(): boolean {
    return (
      this.state.provideState === ProvideState.PAIR_NOT_EXIST ||
      this.state.provideState === ProvideState.CREATE_NEW_PAIR ||
      this.state.provideState === ProvideState.PAIR_LIQUIDITY_ZERO
    );
  }
  private async createNewPairAction(tokenA: Asset, tokenB: Asset): Promise<any> {
    return await CreateNewPair({
      secretjs: this.props.secretjs,
      secretjsSender: this.props.secretjsSender,
      tokenA,
      tokenB,
    });
  }

  private getPrice() {
    return humanizeBalance(this.getPoolA(), this.getDecimalsA()).dividedBy(
      humanizeBalance(this.getPoolB(), this.getDecimalsB()),
    );
  }

  private isReadyForProvide() {
    return (
      this.state.provideState === ProvideState.READY || this.state.provideState === ProvideState.PAIR_LIQUIDITY_ZERO
    );
  }

  private getPoolA() {
    return new BigNumber(
      this.props.balances[`${this.state.tokenA}-${this.props.selectedPair?.identifier()}`] as BigNumber,
    );
  }

  private getPoolB() {
    return new BigNumber(
      this.props.balances[`${this.state.tokenB}-${this.props.selectedPair?.identifier()}`] as BigNumber,
    );
  }
}
