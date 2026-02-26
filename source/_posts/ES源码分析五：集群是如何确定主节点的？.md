---
title: ES源码分析五、集群是如何确定主节点的？
tags: Elasticsearch源码分析&实战
abbrlink: 22852
date: 2021-10-02 15:21:28
---

~Discovery模块负责发现集群中的节点，以及选择主节点。~
~ES内置实现为 Zen Discovery。~

## 5.1 为什么使用主从模式？
除主从模式以外，另一种选择是分布式哈希表DHT，可以支持每小时数千节点的离开和加入。
但是ES典型场景为：当前集群没有那么多节点离开和加入，并且节点数量远小于单个节点能维护的连接数。
所以说ES更适合使用主从模式。

## 5.2 选举算法
* Bully：Leader选举的基本算法之一。
它假定所有节点都有一个唯一的ID， 使用该ID对节点进行排序，即任何时候当前Leader都是参与集群选举的最高ID节点。
但是通过上述选举算法会有脑裂问题，可以通过”法定得票人数过半“解决。
* Paxos：选举灵活性比Bully算法更高，但是实现复杂。

## 5.3 相关配置
* discovery.zen.minimum_master_nodes 最小节点数，法定得票人数过半通过该配置决定。
	该配置可以解决脑裂问题，除此之外，改配置还有其他实际作用。
	1. 触发选主：进入选主的流程之前，参选的节点数需要达到法定人 数。
	2. 决定Master ：选出临时的Master之后，这个临时Master需要判断加入它的节点达到法定人数，才确认选主成功。
	3. gateway选举元信息： 向有Master资格的节点发起请求获取元数据，获取的响应数量必须达到法定人数，也就是参与元信息选举的节点数。
	4. Master发布集群状态： 发布成功数量为多数。
 * discovery.zen.ping.unicast.hosts 集群种子节点列表  构建集群时 本节点会尝试连接这个节点列表，那么列表中的主机会看到整个集群中 都有哪些主机。可以配置为部分或全部集群节点。
 * discovery.zen.join_timeout 节点加入现有集群时的超时时间，默认 为 ping_timeout的20倍。
 * discovery.zen.join_retry_attempts join_timeout 超时之后的重试次 数，默认为3次。
 * discovery.zen.master_election.ignore_non_master_pings  设置为true时，选主阶段将忽略来自不具备Master资格节点(node.master: false)的ping请求，默认为false。

##  5.4 流程分析
ZenDiscovery的选主过程：
1. 每个节点计算最小的已知节点ID，该节点为临时Master，并向该节点发送领导投票。
2. 如果一个节点收到足够多的票数，并且该节点也为自己投票，那么确定Master角色，开始发布集群状态。

~所有节点都会参与选举，并参与投票，但是只有node.master=true的节点投票才有效。~
~获取多少选票才可以赢得选举，就是法定人数，通过discovery.zen.minimum_master_nodes来决定~
~discovery.zen.minimum_master_nodes为了避免脑裂，该配置最小值应为有Master资格节点数n/2+1~

### 5.4.1 具体分析
1. 选举临时Master
	* 如果本节点当选，则等待确立Master
	* 如果其他节点当选，则尝试加入集群，然后启动节点失效探测器。

选举过程的实现位于 ::ZenDiscovery#findMaster::。该函数查找当前集群的活跃 Master，或者从候选者中选择新的Master。如果选主成功，则返回选定的Master，否则返回空。
	* ping所有的节点，获取节点列表fullPingResponses，ping结果不包含本节点，把本节点单独添加到fullPingResponses中。 [第一步]
	* 构建两个列表activeMasters和masterCandidates  [第二步]
	* 如果activeMasters列表为空，则从masterCandidates列表中选举，可能选举失败，也可能成功。如果不为空，则从activeMasters列表中选择最合适的作为Master。（masterCandidates不是从activeMasters中拿的么？）[第三步]
	
> activeMasters：储存集群当前活跃的Master列表，遍历[第一步]获取的所有节点，将每个节点所认为的当前Master节点加入activeMasters列表中(不包括本节点)。  
> 这个过程是将集群当前已存在的Master加入activeMasters列表，正常情况下只有一个。  
> masterCandidates： 存储master候选者列表，遍历第一步获取的列表，去掉不具备Master资格的节点，添加到这个列表中。  

* 从masterCandidates中选择主节点
	具体细节实现封装在::ElectMasterService::类中，例如，判断 候选者是否足够，选择具体的节点作为Master等。
	1. 首先要判断是否达到法定人数，否则选举失败。
	2. 达到法定人数后，通过自定义函数比较器选择一个合适的节点。
```
//自定义函数比较
public static int compare(MasterCandidate c1, MasterCandidate c2) {
		//先比较集群状态版本
		int ret = Long.compare(c2.clusterStateVersion, c1.clusterStateVersiion);
		//如果版本号相同，则比较节点ID
		if (ret == 0) {
			ret = compareNode(c1.getNode(), c2.getNode());
		}
}

public static int compareNode(DiscoveryNode o1, DiscoveryNode o2) {
		//判断两个节点中一个具备Master资格而另一个不具备Master资格的情况
		if (o1.isMasterNode() && !o2.isMasterNode()) {
			return -1;
		}
		if (!o1.isMasterNode() && o2.isMasterNode()) {
			return -1;
		}
		//通过节点ID排序
		return o1.getId().compareTo(o2.getId());
}
```

* 从activeMasters列表中选择
列表存储着集群当前存在活跃的Master，从这些已知的Master节点中选择一个作为选举结果。
当前列表中的节点理论上都是具备Master资格的。
```
public DiscoveryNode tieBreakActiveMasters(Collection<DiscoveryNode> activeMasters) {
		return activeMasters.stream().min(EkectMasterService::compareNodes).get();
}
```

### 5.4.2 投票与得票的实现
在ES中，发送投票就是发送加入集群(JoinRequest)请求。得票就 是申请加入该节点的请求的数量。
收集投票，进行统计的实现在ZenDiscovery#handleJoinRequest方法 中，收到的连接被存储到ElectionContext.joinRequestAccumulator中。当 节点检查收到的投票是否足够时，就是检查加入它的连接数是否足够， 其中会去掉没有Master资格节点的投票。

### 5.4.3 临时Master节点确认后如何确定正式Master节点的？
选举出的临时Master有两种情况：
* 该临时节点是本节点
	1. 等待足够多的具备Master资格的节点加入本节点（法定投票人数），完成选举。
	2. 超时（默认30s）后还没有达到法定人数，需要重新选举。
	3. 成功后发布新的clusterState。
* 该临时节点不是本节点
	1. 不再接受其他节点的join请求。
	2. 向临时Master节点发送加入请求并等待回复。
	3. 最终当选的master先发布集群状态，再确认join请求。

## 5.5 节点失效检测
选主流程结束后确认Master身份，集群开始运行后会持续检测节点失效状态（是否离线）。
* NodesFD
在Master节点，启动NodesFaultDetection，定期探 测加入集群的节点是否活跃。
* MasterFD
在非Master节点启动MasterFaultDetection，定期探 测Master节点是否活跃。

> NodesFaultDetection和MasterFaultDetection都是通过定期(默认为1 秒)发送的ping请求探测节点是否正常的，当失败达到一定次数(默认 为3次)，或者收到来自底层连接模块的节点离线通知时，开始处理节 点离开事件。  

### 5.5.1  NodesFaultDetection处理流程
检查一下当前集群总节点数是否达到法定节点数(过半)，如果不 足，则会放弃 Master 身份，重新加入集群。

检测原因：避免脑裂
对应事件处理主要实现如下:在 ZenDiscovery#handleNodeFailure 中执行NodeRemovalClusterStateTaskExecutor.execute。
主节点在探测到节点离线的事件处理中，如果发现当前集群节点数 量不足法定人数，则放弃Master身份，从而避免产生双主。

```
@Override
public ClusterTasksResult<Task> execute(final ClusterState currentState, final List<Task> tasks) throws Exception {
    if (electMasterService.hasEnoughMasterNodes(remainingNodesClusterState.nodes()) == false) {
        final int masterNodes = electMasterService.countMasterNodes(remainingNodesClusterState.nodes());
        rejoin.accept(LoggerMessageFormat.format("not enough master nodes (has [{}], but needed [{}])", masterNodes, electMasterService.minimumMasterNodes()));
        return resultBuilder.build(currentState);
    } else {
        return resultBuilder.build(allocationService.deassociateDeadNodes(remainingNodesClusterState, true, describeTasks(tasks)));
    }
}

```

### 5.5.2  MasterFaultDetection处理流程
探测Master离线的处理很简单，重新加入集群。 本质上是重新执行一遍选主流程。
对应事件处理主要实现如下:ZenDiscovery#handleMasterGone

```
private void handleMasterGone(final DiscoveryNode masterNode, final Throwable cause, final String reason) {
    synchronized (stateMutex) {
        if (!localNodeMaster() && masterNode.equals(committedState.get().nodes().getMasterNode())) {
            // flush any pending cluster states from old master, so it will not be set as master again
            pendingStatesQueue.failAllStatesAndClear(new ElasticsearchException("master left [{}]", reason));
            rejoin("master left (reason = " + reason + ")");
        }
    }
}

```













