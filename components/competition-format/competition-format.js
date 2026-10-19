const controller=require('../../utils/elimination-board').controller
Component({
  properties:{model:{type:Object,value:null,observer:'updateModel'}},
  data:{open:false,tabs:[],activeKey:'',active:null,groupIndex:0,group:null,selectedSeries:'',bracket:null},
  methods:{
    ...controller,
    updateModel(model){
      const tabs=model&&model.tabs || []
      const same=this.modelKey===model?.key
      this.modelKey=model&&model.key
      const active=(same&&tabs.find(t=>t.key===this.data.activeKey)) || tabs.find(t=>t.key===model?.initial) || tabs[0] || null
      this.setData({tabs,open:same?this.data.open:!!model?.expanded,activeKey:active?active.key:'',active,groupIndex:same?this.data.groupIndex:0,
        selectedSeries:same?this.data.selectedSeries:'',...this.activeState(active,same?this.data.groupIndex:0)})
    },
    activeState(active,index){
      const groups=active&&active.groups || [],group=groups[index] || groups[0] || null
      const bracket=active&&active.tree || null
      return {group,bracket,...this.bracketState(bracket,active?active.key:'')}
    },
    onToggle(){this.setData({open:!this.data.open})},
    onPhase(e){const active=this.data.tabs.find(t=>t.key===e.currentTarget.dataset.key);if(!active)return
      this.setData({active,activeKey:active.key,groupIndex:0,selectedSeries:'',...this.activeState(active,0)})},
    onGroup(e){const index=Number(e.currentTarget.dataset.index);this.setData({groupIndex:index,group:this.data.active.groups[index] || null})},
    onSeries(e){const key=e.currentTarget.dataset.key;this.setData({selectedSeries:this.data.selectedSeries===key?'':key})},
    onBoardMatch(e){
      const tie=(this.data.active&&this.data.active.series || []).find(s=>s.key===e.detail.id)
      if(tie){this.setData({selectedSeries:tie.key});return}
      this.goDetail({currentTarget:{dataset:{id:e.detail.id}}})
    },
    goDetail(e){this.triggerEvent('matchtap',{id:e.currentTarget.dataset.id})},
  },
})
