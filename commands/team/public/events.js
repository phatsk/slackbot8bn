// setup the axios default

axios.defaults.baseURL = document.location.href;
axios.defaults.headers.common['Authorization'] = (function() {
  // get the session cookie
  // should already be URL safe
  var c = document.cookie.match(/8bn-team=([^;]+)/);
  if(c && c.length > 1) return c[1];
})();
axios.defaults.headers.post['Content-Type'] = 'application/json';
axios.defaults.headers.put['Content-Type'] = 'application/json';

Vue.component('participant-item', {
  props: ['participant', 'event'],
  template: '#participant-item-template',
  methods: {
    leave: function() {
      console.log("leaving: "+event.id);
      this.$root.$data.inProgress = true;
      var that = this;
      //this.event.participants.push(this.$root.$data.token.user);
      axios.get('events/'+this.event.id+'/leave').then(function(res) {
        console.log(res);
        return that.$root.updateData();
      }).then( function(d) {
        that.$root.$data.inProgress = false;
      }).catch(function(err) {
        that.$root.showError('failed to leave event', err);
        that.$root.$data.inProgress = false;
      });
    }
  }
});

Vue.component('event-item', {
	props: ['event'],
  template: '#event-item-template',
  methods: {
  	toggleVisible: function() {
    	this.event.visible = !this.event.visible;
    },
    join: function(type) {
      //
      var that = this;
      console.log('join as '+type);
      this.$root.$data.inProgress = true;
      axios.post('events/'+this.event.id+'/join', { type: type}
      ).then(function (res) {
        console.log(res);
        that.$root.updateData();
      }).then( function (d) {
        that.$root.$data.inProgress = false;
      }).catch(function (err) {
        that.$root.showError('failed to join event', err);
        that.$root.$data.inProgress = false;
      });
    }
    
  }
});

Vue.component('channel-item', {
  props: ['channel'],
  template: '#channel-item-template',
  data: function() {
    var datePicker = this.$root.$data.datePicker;
    return {
      newEvent: false,
      event: {
        name: '',
        date: datePicker.dates[0].value,
        hour: datePicker.now.hour,
        channel: this.channel.id,
        minutes: datePicker.now.minutes,
        period: datePicker.now.period
      },
      dates: datePicker.dates,
      hours: datePicker.hours,
      minutes: datePicker.minutes,
      periods: [ 'AM', 'PM' ]
    }
  },
  methods: {
  	toggleVisible: function() {
    	this.channel.visible = !this.channel.visible;
    },
    create: function() {
      //
      var that = this;
      console.log('creating new event '+ this.event);
      this.$root.$data.inProgress = true;
      //this.event.participants.push(this.$root.$data.token.user);
      axios.post('events', { event: this.event }).then(function (res) {
        console.log(res);
        return that.$root.updateData();
      }).then( function (d) {
        // hide the new event
        that.newEvent = false;
        that.$root.$data.inProgress = false;
      }).catch(function (err) {
        that.$root.showError('failed to create event', err);
        that.$root.$data.inProgress = false;
      });
    },
  }
});

var app = new Vue({
  el: '#app',
  computed: {
  },
  data: {
    validAuth: !!axios.defaults.headers.common['Authorization'],
    inProgress: false,
    error: {
      message: '',
      detail: '',
      detailVisible: false
    },
    token: {},
    channels: [],
    datePicker: {}

  },
  methods: {
    showError: function(msg, err) {
      if(err) {
        console.log(err);
        this.error.message = msg + ': ' + err;
        if(err.response) {
          this.error.detail = err.response.data;
        } else if(err.request) {
          this.error.detail = err.request;
        } else {
          this.error.detail = err.stack;
        }
      } else {
        this.error.message = msg;
        this.error.detail = '';
      }
    },
    updateData: function() {
      var that = this;
      console.log('updateData');
      return axios.get('events').then(function (res) {
        console.log(res);
        if(res.data.status === 'ok') {
          // keep the current visible state
          that.mergeVisible(that.channels, res.data.channels);
          // finally overwrite the current data
          // need to do this for each root element
          // 
          that.token = res.data.token;
          that.channels = res.data.channels;
          that.datePicker = res.data.datePicker;
          return Promise.resolve(res.data);
        } else {
          return Promise.reject(res.data.status);
        }
      });
    },
    mergeVisible: function(oldData, newData) {
      var that = this;
      // merge the current and new visible states
      newData.forEach(function (n) {
        for (var i=0; i < oldData.length; i++) {
          if (oldData[i].id === n.id) {
              // found it, set the visibility
              n.visible = oldData[i].visible;
              // now merge the events if they exist
              if(n.events) that.mergeVisible(oldData[i].events, n.events);
              break; // our work here is done
          }
        }
      });
    
    }
  },
  watch: {
    events: function() {
      console.log('events updated');
    }
  },
  created: function() {
    console.log('created');
    var that = this;
    // only try and download data if we have a cookie
    if(!this.validAuth) return;

    this.inProgress = true;
    this.updateData().then(function (d) {
      that.inProgress = false;
    }).catch(function (err) {
      that.inProgress = false;
      that.showError('failed to get event data', err);
    });
  }
});